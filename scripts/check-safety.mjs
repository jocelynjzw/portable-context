import { execFileSync } from 'node:child_process';

const allowed = new Set([
  '.gitignore', '.env.example', 'LICENSE', 'README.md', 'package.json', 'package-lock.json',
  'tsconfig.json', 'src/store.ts', 'src/cli.ts', 'src/server.ts',
  'test/client.mjs', 'test/integration.test.mjs', 'scripts/check-safety.mjs',
]);
const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: new URL('../', import.meta.url),
  encoding: 'utf8',
}).split('\0').filter(Boolean);
const unexpected = paths.filter(path => !allowed.has(path));
if (unexpected.length) {
  console.error('发现未列入公开清单的文件，请检查：');
  for (const path of unexpected) console.error(JSON.stringify(path));
  process.exitCode = 1;
} else {
  console.log('安全检查通过。仓库已跟踪及未忽略的文件均在公开清单内。');
}
