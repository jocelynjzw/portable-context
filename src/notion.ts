import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  StoreError, dataDirectory, fields, readInput, editInput, correctInput,
  memorySearch, exportMemories, type Memory,
} from './store.js';

const payloadColumn = 'Portable Context v1';
const apiVersion = '2025-09-03';
const uuid = z.uuid();
const metadata = z.object({
  id: uuid,
  rootId: uuid,
  replacesId: uuid.nullable(),
  version: z.number().int().positive(),
  recordedAt: z.iso.datetime(),
});
const entrySchema = z.discriminatedUnion('kind', [
  metadata.extend({ kind: z.literal('memory'), data: fields }),
  metadata.extend({ kind: z.literal('deleted') }),
]);
type Entry = z.infer<typeof entrySchema>;
type MemoryEntry = Extract<Entry, { kind: 'memory' }>;

const databaseSchema = z.object({
  object: z.literal('database'),
  data_sources: z.array(z.object({ id: uuid })).length(1),
});
const sourceSchema = z.object({
  object: z.literal('data_source'),
  properties: z.object({
    Name: z.object({ type: z.literal('title') }),
    [payloadColumn]: z.object({ type: z.literal('rich_text') }),
  }),
});
const textItems = z.array(z.object({ type: z.literal('text'), plain_text: z.string() }));
const pageSchema = z.object({
  object: z.literal('page'),
  properties: z.object({
    Name: z.object({ type: z.literal('title'), title: textItems }),
    [payloadColumn]: z.object({ type: z.literal('rich_text'), rich_text: textItems }),
  }),
});
const querySchema = z.object({
  object: z.literal('list'),
  results: z.array(pageSchema),
  has_more: z.boolean(),
  next_cursor: z.string().min(1).nullable(),
  request_status: z.object({ type: z.string() }).optional(),
});

const badResponse = () => new StoreError('NOTION_DATA: Check the dedicated database and its stored records.');
const conflict = () => new StoreError('VERSION_CONFLICT: Read the latest revision. If revisions diverged, review both branches in Notion.');
const uncertain = (id: string) => new StoreError(
  `NOTION_WRITE_UNCERTAIN: Check Notion for revision ${id} before trying again.`,
);

function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badResponse();
  return parsed.data;
}

function textProperty(value: string) {
  const parts: string[] = [];
  let part = '';
  for (const character of value) {
    if (part.length + character.length > 1800) {
      parts.push(part);
      part = '';
    }
    part += character;
  }
  parts.push(part);
  if (parts.length > 100) throw new StoreError('NOTION_TEXT_LIMIT: This record is too large for Notion. Shorten it and try again.');
  return parts.map(content => ({ type: 'text', text: { content } }));
}

function toMemory({ kind: _kind, data, ...metadata }: MemoryEntry, next?: Entry): Memory {
  return {
    ...data, ...metadata,
    status: next ? 'superseded' : 'active',
    replacedById: next?.id ?? null,
  };
}

export class NotionStore {
  private readonly token: string;
  private readonly databaseId: string;
  private sourceId?: Promise<string>;

  constructor(env: NodeJS.ProcessEnv, private readonly fetchRequest: typeof fetch = fetch) {
    const token = env.PORTABLE_CONTEXT_NOTION_TOKEN;
    const database = env.PORTABLE_CONTEXT_NOTION_DATABASE_ID;
    if (!token || !/^(ntn_|secret_)[a-zA-Z0-9_-]+$/.test(token)) {
      throw new StoreError('NOTION_CONFIG: Set PORTABLE_CONTEXT_NOTION_TOKEN to a Notion integration token.');
    }
    const compact = database?.replace(/^([a-f0-9]{8})-([a-f0-9]{4})-([a-f0-9]{4})-([a-f0-9]{4})-([a-f0-9]{12})$/i, '$1$2$3$4$5');
    if (!compact || !/^[a-f0-9]{32}$/i.test(compact)) {
      throw new StoreError('NOTION_CONFIG: Set PORTABLE_CONTEXT_NOTION_DATABASE_ID to a database ID.');
    }
    this.token = token;
    this.databaseId = compact.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  }

  close() {}

  private async request(path: string, body?: object, writeId?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchRequest('https://api.notion.com/v1/' + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Notion-Version': apiVersion,
          'Content-Type': 'application/json',
        },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
    } catch {
      throw writeId ? uncertain(writeId) : new StoreError('NOTION_UNAVAILABLE: Could not reach Notion. Check the connection and try again.');
    }
    if (!response.ok) {
      if (response.status === 401) throw new StoreError('NOTION_AUTH: Check the integration token.');
      if (response.status === 403 || response.status === 404) {
        throw new StoreError('NOTION_ACCESS: Check the database ID and the integration’s access.');
      }
      if (response.status === 429) throw new StoreError('NOTION_RATE_LIMIT: Notion is limiting requests. Wait before trying again.');
      if (response.status === 409) throw conflict();
      if (writeId && response.status >= 500) throw uncertain(writeId);
      if (response.status >= 500) throw new StoreError('NOTION_UNAVAILABLE: The Notion service is unavailable. Try again later.');
      throw new StoreError('NOTION_REQUEST: Notion rejected the request. Check the dedicated database setup.');
    }
    try {
      return await response.json();
    } catch {
      throw writeId ? uncertain(writeId) : badResponse();
    }
  }

  private dataSource(): Promise<string> {
    this.sourceId ??= this.loadDataSource().catch(error => {
      this.sourceId = undefined;
      throw error;
    });
    return this.sourceId;
  }

  private async loadDataSource() {
    const database = decode(databaseSchema, await this.request('databases/' + this.databaseId));
    const { id } = database.data_sources[0];
    decode(sourceSchema, await this.request('data_sources/' + id));
    return id;
  }

  private async chains() {
    const source = await this.dataSource();
    const chains = new Map<string, Entry[]>();
    const cursors = new Set<string>();
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = decode(querySchema, await this.request(`data_sources/${source}/query`, {
        page_size: 100, start_cursor: cursor,
        sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
      }));
      if (response.request_status && response.request_status.type !== 'complete') throw badResponse();
      for (const page of response.results) {
        const title = page.properties.Name.title.map(item => item.plain_text).join('');
        const payload = page.properties[payloadColumn].rich_text.map(item => item.plain_text).join('');
        let value: unknown;
        try {
          value = JSON.parse(payload);
        } catch {
          throw badResponse();
        }
        const entry = decode(entrySchema, value);
        if (entry.id !== title || ids.has(entry.id)) throw badResponse();
        ids.add(entry.id);
        if (ids.size >= 10_000) {
          throw new StoreError('NOTION_SCAN_LIMIT: The dedicated database is too large to scan safely.');
        }
        const chain = chains.get(entry.rootId) ?? [];
        chain.push(entry);
        chains.set(entry.rootId, chain);
      }
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
      if (response.has_more && (!cursor || cursors.has(cursor))) throw badResponse();
      if (cursor) cursors.add(cursor);
    } while (cursor);

    for (const chain of chains.values()) {
      chain.sort((a, b) => a.version - b.version);
      for (const [index, entry] of chain.entries()) {
        const previous = chain[index - 1];
        if (entry.version !== index + 1 || entry.replacesId !== (previous?.id ?? null)
          || (!previous && entry.id !== entry.rootId) || previous?.kind === 'deleted') throw conflict();
      }
    }
    return chains;
  }

  private async append(entry: Entry) {
    const dataSource = await this.dataSource();
    const response = await this.request('pages', {
      parent: { type: 'data_source_id', data_source_id: dataSource },
      properties: {
        Name: { title: textProperty(entry.id) },
        [payloadColumn]: { rich_text: textProperty(JSON.stringify(entry)) },
      },
    }, entry.id);
    if (!z.object({ object: z.literal('page'), id: uuid }).safeParse(response).success) {
      throw uncertain(entry.id);
    }
    const chain = await this.chains().then(chains => chains.get(entry.rootId)).catch(error => {
      if (error instanceof StoreError && error.message.startsWith('VERSION_CONFLICT:')) throw error;
      throw uncertain(entry.id);
    });
    if (chain?.at(-1)?.id !== entry.id) throw uncertain(entry.id);
  }

  async write(input: unknown) {
    const data = fields.parse(input);
    const id = randomUUID();
    const entry: MemoryEntry = {
      kind: 'memory', data, id, rootId: id, replacesId: null, version: 1, recordedAt: new Date().toISOString(),
    };
    await this.append(entry);
    return toMemory(entry);
  }

  async read(input: unknown) {
    const { id } = readInput.parse(input);
    for (const chain of (await this.chains()).values()) {
      if (chain.at(-1)?.kind === 'deleted') continue;
      const index = chain.findIndex(entry => entry.id === id);
      const entry = chain[index];
      if (entry?.kind === 'memory') return toMemory(entry, chain[index + 1]);
    }
    throw new StoreError('NOT_FOUND: No memory with this ID.');
  }

  async search(input: unknown) {
    const { limit, matches } = memorySearch(input);
    return [...(await this.chains()).values()]
      .map(chain => chain.at(-1))
      .filter((entry): entry is MemoryEntry => entry?.kind === 'memory')
      .map(entry => toMemory(entry))
      .filter(matches)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  private async next(id: string, expectedVersion: number) {
    for (const chain of (await this.chains()).values()) {
      const latest = chain.at(-1);
      if (!chain.some(entry => entry.id === id)) continue;
      if (latest?.kind !== 'memory' || latest.id !== id || latest.version !== expectedVersion) throw conflict();
      return {
        latest,
        metadata: {
          id: randomUUID(), rootId: latest.rootId, replacesId: id,
          version: latest.version + 1, recordedAt: new Date().toISOString(),
        },
      };
    }
    throw new StoreError('NOT_FOUND: No memory with this ID.');
  }

  async correct(input: unknown) {
    const { id, expectedVersion, subject, scope, ...data } = correctInput.parse(input);
    const { latest, metadata } = await this.next(id, expectedVersion);
    const entry: MemoryEntry = {
      ...metadata, kind: 'memory',
      data: { ...data, subject: subject ?? latest.data.subject, scope: scope ?? latest.data.scope },
    };
    await this.append(entry);
    return toMemory(entry);
  }

  async delete(input: unknown) {
    const { id, expectedVersion } = editInput.parse(input);
    const { metadata, latest } = await this.next(id, expectedVersion);
    await this.append({ ...metadata, kind: 'deleted' });
    return { id, deletedRevisions: latest.version, retainedInNotion: true };
  }

  async export() {
    const chains = [...(await this.chains()).values()].sort((a, b) => a[0].rootId.localeCompare(b[0].rootId));
    const rows = chains.flatMap(chain => {
      if (chain.at(-1)?.kind === 'deleted') return [];
      return chain.flatMap((entry, index) => entry.kind === 'memory' ? [toMemory(entry, chain[index + 1])] : []);
    });
    return exportMemories(dataDirectory(), rows);
  }
}
