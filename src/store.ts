import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const wellFormed = (value: string) => !/[\u0000\uD800-\uDFFF]/u.test(value);
const line = z.string().max(1000).trim().min(1)
  .refine(value => wellFormed(value) && !/[\r\n]/.test(value));
const content = z.string().max(50_000).trim().min(1).refine(wellFormed);
const id = z.uuid();

function checkedDirectory(directory: string): string {
  if (!isAbsolute(directory) || directory.split(/[\\/]/).includes('..')) {
    throw new StoreError('DATA_PATH: Use an absolute data directory without parent traversal.');
  }
  // Resolve existing ancestors before creating anything, including symlink targets.
  function canonical(path: string): string {
    try {
      return realpathSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(path);
      if (parent === path) throw error;
      return join(canonical(parent), relative(parent, path));
    }
  }
  const target = canonical(resolve(directory));
  const project = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
  for (let path = target; ; path = dirname(path)) {
    if (relative(project, path) === '' || lstatSync(join(path, '.git'), { throwIfNoEntry: false })) {
      throw new StoreError('DATA_PATH: Keep the data directory outside Git repositories and the package.');
    }
    if (dirname(path) === path) break;
  }
  return target;
}

export class StoreError extends Error {}

const unknownFields = { error: 'Unexpected input field.' };

export const fields = z.strictObject({
  subject: line,
  content,
  source: line,
  time: z.union([z.iso.date(), z.iso.datetime({ offset: true })]),
  scope: line,
}, unknownFields);
export const readInput = z.strictObject({ id }, unknownFields);
export const editInput = readInput.extend({
  expectedVersion: z.number().int().positive(),
});
export const correctInput = editInput.extend({
  content,
  source: line,
  time: fields.shape.time,
  subject: line.optional(),
  scope: line.optional(),
});
export const searchInput = z.strictObject({
  query: line.optional(),
  subject: line.optional(),
  scope: line.optional(),
  limit: z.number().int().min(1).max(1000).default(50),
}, unknownFields);

export type Fields = z.infer<typeof fields>;
export type Memory = Fields & {
  id: string;
  rootId: string;
  replacesId: string | null;
  replacedById: string | null;
  status: 'active' | 'superseded';
  version: number;
  recordedAt: string;
};

export function dataDirectory(): string {
  const override = process.env.PORTABLE_CONTEXT_DATA_DIR;
  if (override) return override;
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'portable-context');
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    return join(appData && isAbsolute(appData) ? appData : join(home, 'AppData', 'Roaming'), 'portable-context');
  }
  const xdg = process.env.XDG_DATA_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'share'), 'portable-context');
}

export class Store {
  private readonly db: DatabaseSync;

  private readonly directory: string;

  constructor(directory: string) {
    this.directory = checkedDirectory(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, 'memories.sqlite');
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const entry = lstatSync(file + suffix, { throwIfNoEntry: false });
      if (entry && (!entry.isFile() || entry.nlink !== 1)) {
        throw new StoreError('DATA_PATH: Database files must be regular files without links.');
      }
    }
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      if (fstatSync(fd).nlink !== 1) throw new StoreError('DATA_PATH: Database files must not be linked.');
    } finally {
      closeSync(fd);
    }
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA synchronous = FULL;
        PRAGMA secure_delete = ON;
      `);
      this.transaction(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY NOT NULL,
        rootId TEXT NOT NULL,
        replacesId TEXT,
        replacedById TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
        version INTEGER NOT NULL,
        subject TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        time TEXT NOT NULL,
        scope TEXT NOT NULL,
        recordedAt TEXT NOT NULL,
        UNIQUE (rootId, version)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_revision ON memories (rootId) WHERE status = 'active';
      `));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  private insert(memory: Memory): Memory {
    this.db.prepare(`
      INSERT INTO memories (id, rootId, replacesId, replacedById, status, version,
        subject, content, source, time, scope, recordedAt)
      VALUES ($id, $rootId, $replacesId, $replacedById, $status, $version,
        $subject, $content, $source, $time, $scope, $recordedAt)
    `).run(memory);
    return memory;
  }

  write(input: unknown): Memory {
    const data = fields.parse(input);
    const id = randomUUID();
    return this.transaction(() => this.insert({
      ...data, id, rootId: id, replacesId: null, replacedById: null,
      status: 'active', version: 1, recordedAt: new Date().toISOString(),
    }));
  }

  read(input: unknown): Memory {
    const { id } = readInput.parse(input);
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    if (!row) throw new StoreError('NOT_FOUND: No memory with this ID.');
    return row as Memory;
  }

  search(input: unknown): Memory[] {
    const { limit, matches } = memorySearch(input);
    const results: Memory[] = [];
    for (const row of this.db.prepare("SELECT * FROM memories WHERE status = 'active' ORDER BY recordedAt DESC, id").iterate()) {
      const memory = row as Memory;
      if (!matches(memory)) continue;
      results.push(memory);
      if (results.length === limit) break;
    }
    return results;
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private current(id: string, expectedVersion: number): Memory {
    const memory = this.read({ id });
    if (memory.status !== 'active' || memory.version !== expectedVersion) {
      throw new StoreError('VERSION_CONFLICT: Read the latest active revision before editing.');
    }
    return memory;
  }

  correct(input: unknown): Memory {
    const { id, expectedVersion, subject, scope, ...data } = correctInput.parse(input);
    return this.transaction(() => {
      const previous = this.current(id, expectedVersion);
      const nextId = randomUUID();
      this.db.prepare("UPDATE memories SET status = 'superseded', replacedById = ? WHERE id = ?")
        .run(nextId, id);
      return this.insert({
        ...data, subject: subject ?? previous.subject, scope: scope ?? previous.scope,
        id: nextId, rootId: previous.rootId, replacesId: id, replacedById: null,
        status: 'active', version: previous.version + 1, recordedAt: new Date().toISOString(),
      });
    });
  }

  delete(input: unknown) {
    const { id, expectedVersion } = editInput.parse(input);
    return this.transaction(() => {
      const { rootId } = this.current(id, expectedVersion);
      const { changes } = this.db.prepare('DELETE FROM memories WHERE rootId = ?').run(rootId);
      return { id, deletedRevisions: Number(changes) };
    });
  }

  export(): { path: string } {
    return exportMemories(this.directory, this.db.prepare('SELECT * FROM memories ORDER BY rootId, version').all());
  }
}

export function memorySearch(input: unknown) {
  const { query, subject, scope, limit } = searchInput.parse(input);
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
  const terms = query ? normalize(query).split(/\s+/) : [];
  const matches = (memory: Memory) => {
    if (subject && normalize(memory.subject) !== normalize(subject)) return false;
    if (scope && normalize(memory.scope) !== normalize(scope)) return false;
    const searchable = [memory.subject, memory.content, memory.source, memory.scope].map(normalize);
    return terms.every(term => searchable.some(value => value.includes(term)));
  };
  return { limit, matches };
}

export function exportMemories(target: string, rows: readonly object[]): { path: string } {
  const directory = checkedDirectory(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `portable-context-export-${randomUUID()}.json`);
  const temporary = path + '.tmp';
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(rows, null, 2) + '\n');
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { path };
}
