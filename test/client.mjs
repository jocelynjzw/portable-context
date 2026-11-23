import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const directory = process.argv[2];
if (!directory) throw new Error('A temporary data directory is required.');

const client = new Client({ name: 'portable-context-test', version: '1.0.0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/server.js', import.meta.url))],
  env: { PORTABLE_CONTEXT_DATA_DIR: directory },
  stderr: 'ignore',
}));
process.on('message', async ({ tool, args }) => {
  try {
    process.send(await client.callTool({ name: tool, arguments: args }));
  } catch (error) {
    process.send({ transportError: String(error) });
  }
});
process.on('disconnect', async () => { await client.close(); });
process.send({ ready: true });
