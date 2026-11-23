#!/usr/bin/env node
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { StoreError } from './store.js';
import { openBackend } from './backend.js';

const help = `用法
  portable-context list [--subject 主体] [--scope 范围] [--limit 数量]
  portable-context show ID
  portable-context search "关键词" [--subject 主体] [--scope 范围] [--limit 数量]
  portable-context correct ID --version 版本 --content "新内容" --source "来源" --time YYYY-MM-DD
  portable-context delete ID --version 版本
  portable-context export
输出为 JSON。导出返回文件位置，文件包含历史版本，请存放在仓库外。
使用 Notion 时，删除会隐藏整条记忆，原始页面仍留在 Notion。`;

function number(value: unknown, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new StoreError(`${flag} 需要整数。`);
  return Number(value);
}

async function main([command, ...args]: string[]) {
  if (!command || command === '--help' || command === '-h') {
    console.log(help);
    return;
  }

  const stringOption = { type: 'string' } as const;
  const filters = { subject: stringOption, scope: stringOption, limit: stringOption };
  const revision = { version: stringOption } as const;
  const options: Record<string, ParseArgsOptionsConfig> = {
    list: filters, search: filters, show: {}, export: {}, delete: revision,
    correct: { ...revision, content: stringOption, source: stringOption, time: stringOption },
  } as const;
  if (!Object.hasOwn(options, command)) throw new StoreError('未知命令，请用 --help 查看用法。');
  const { positionals, values } = parseArgs({
    args, options: options[command], allowPositionals: true,
  });
  const count = command === 'list' || command === 'export' ? 0 : 1;
  if (positionals.length !== count) throw new StoreError('参数数量不对，请用 --help 查看用法。');

  const store = openBackend();
  try {
    const [value] = positionals;
    const { version, content, source, time, subject, scope, limit } = values;
    const edit = { id: value, expectedVersion: number(version, '--version') };
    let output;
    switch (command) {
      case 'list':
      case 'search':
        output = store.search({ query: value, subject, scope, limit: number(limit, '--limit') });
        break;
      case 'show': output = store.read({ id: value }); break;
      case 'correct': output = store.correct({ ...edit, content, source, time }); break;
      case 'delete': output = store.delete(edit); break;
      case 'export': output = store.export(); break;
    }
    console.log(JSON.stringify(await output, null, 2));
  } finally {
    store.close();
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof StoreError ? error.message : '操作失败，请检查参数或数据目录。');
  process.exitCode = 1;
}
