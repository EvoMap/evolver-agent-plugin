import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { PROMPT } from '../app/memory-ports.js';
import { fakeProxy } from '../helpers/fake-proxy.js';

let proxy;
let client;
before(async () => {
  proxy = await fakeProxy();
  client = new Client({ name: 'evolver-test-client', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../../bin/mcp.mjs', import.meta.url)), 'mcp-generic'],
    env: proxy.env,
    stderr: 'pipe',
  }));
});
after(async () => {
  await client.close();
  proxy.close();
});

const textOf = (result) => result.content.map((part) => part.text).join('');

test('an official MCP client sees exactly the six Evolver tools', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['evolver_distill', 'evolver_drafts', 'evolver_recall', 'evolver_report', 'evolver_search', 'evolver_status']);
});

test('recall, report and status run one turn over stdio, the report counting as agent-reported', async () => {
  const recalled = textOf(await client.callTool({ name: 'evolver_recall', arguments: { task: PROMPT } }));
  assert.ok(recalled.endsWith('Apply them where they fit.'));
  const reported = textOf(await client.callTool({ name: 'evolver_report', arguments: { outcome: 'success', summary: 'Fixed the retries.', checks: [{ command: 'npm test', exit: 0 }], files: ['lib/redis.js'] } }));
  assert.match(reported, /call evolver_distill with written_for \d+/);
  const status = textOf(await client.callTool({ name: 'evolver_status', arguments: {} }));
  assert.match(status, /Evolver Proxy running/);
});

test('a malformed call is refused by the schema, not by a crash', async () => {
  const result = await client.callTool({ name: 'evolver_report', arguments: { outcome: 'maybe' } });
  assert.equal(result.isError, true);
});
