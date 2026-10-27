import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { PROMPT } from '../app/memory-ports.js';
import { installFakeEvolver } from '../helpers/fake-evolver.js';
import { fakeProxy } from '../helpers/fake-proxy.js';

const SERVER = fileURLToPath(new URL('../../bin/mcp.mjs', import.meta.url));
const GENE = { title: 'Stabilise Redis retries', summary: 'Flaky Redis-backed tests stop failing once retries are unbounded and the client is shared.', strategy: ['Set maxRetriesPerRequest to null', 'Share one client', 'Close it in teardown'] };

let proxy;
before(async () => {
  proxy = await fakeProxy({ distillAnswer: {
    ok: true, status: 'draft', distill_id: 'd'.repeat(16), quality: { ok: true, score: 6, threshold: 5 },
    gene: { type: 'Gene', asset_id: 'sha256:' + 'g'.repeat(64), summary: GENE.summary },
    capsule: { type: 'Capsule', asset_id: 'sha256:' + 'c'.repeat(64), summary: GENE.summary },
  } });
});
after(() => proxy.close());

async function connected(t, env = {}) {
  const client = new Client({ name: 'evolver-test-client', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER, 'mcp-generic'], env: { ...proxy.env, ...env }, stderr: 'pipe' }));
  t.after(() => client.close());
  return client;
}

const textOf = (result) => result.content.map((part) => part.text).join('\n');
const turnIdOf = (text) => /turn_id: (\S+)/.exec(text)?.[1];
const call = (client, name, args = {}) => client.callTool({ name, arguments: args });

test('an official MCP client sees exactly the seven Evolver tools', async (t) => {
  const { tools } = await (await connected(t)).listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['evolver_distill', 'evolver_drafts', 'evolver_login', 'evolver_recall', 'evolver_report', 'evolver_search', 'evolver_status']);
});

test('a recalled turn is reported under its turn_id, agent-reported, and its Gene becomes a draft', async (t) => {
  const client = await connected(t);
  const recalled = textOf(await call(client, 'evolver_recall', { task: PROMPT }));
  assert.match(recalled, /Apply them where they fit\./);
  const turnId = turnIdOf(recalled);
  const reported = textOf(await call(client, 'evolver_report', { turn_id: turnId, outcome: 'success', summary: 'Fixed the retries.', checks: [{ command: 'npm test', exit: 0 }], files: ['lib/redis.js'] }));
  const writtenFor = Number(/written_for (\d+)/.exec(reported)?.[1]);
  assert.ok(writtenFor > 0);
  assert.match(textOf(await call(client, 'evolver_distill', { written_for: writtenFor + 1, gene: GENE })), /newer turn replaced/);
  assert.match(textOf(await call(client, 'evolver_distill', { written_for: writtenFor, gene: GENE })), /Distilled "Stabilise Redis retries" into a draft/);
  assert.match(textOf(await call(client, 'evolver_drafts')), /Stabilise Redis retries/);
  const delivered = () => proxy.requests.find((request) => request.path === '/asset/reuse-result')?.body;
  for (let tries = 0; tries < 50 && !delivered(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual([delivered().evidence.tier, delivered().evidence.reported_by], ['none', 'agent']);
});

test('a report that names no open turn reports nothing', async (t) => {
  const client = await connected(t);
  const first = turnIdOf(textOf(await call(client, 'evolver_recall', { task: PROMPT })));
  await call(client, 'evolver_recall', { task: 'now document the redis retry settings in the readme' });
  assert.match(textOf(await call(client, 'evolver_report', { turn_id: first, outcome: 'success', summary: 'x' })), /^Not reported: no task with this turn_id is open/);
});

test('a malformed call is refused by the schema, and a search with no hit is no error', async (t) => {
  const client = await connected(t);
  assert.equal((await call(client, 'evolver_report', { outcome: 'maybe' })).isError, true);
  const none = await call(client, 'evolver_search', { query: 'zzzz qqqq unrelated words' });
  assert.notEqual(none.isError, true);
});

// Node 22 holds a process that ever called fetch for about 3 s after process.exit, so the test times the session
// end the server writes, not the exit.
test('a closing client ends the session at once, even while a call still waits on the Proxy', async (t) => {
  const slow = await fakeProxy({ delays: { '/asset/fetch': 30_000 } });
  t.after(() => slow.close());
  const client = await connected(t, slow.env);
  const recall = call(client, 'evolver_recall', { task: PROMPT }).catch(() => null);
  for (let tries = 0; tries < 100 && !slow.requests.some((request) => request.path === '/asset/fetch'); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const state = join(slow.env.HOME, '.evolver', 'state');
  const isEnded = () => readdirSync(state).filter((name) => /^mcp-generic-session-.*\.json$/.test(name))
    .some((name) => JSON.parse(readFileSync(join(state, name), 'utf8')).open === false);
  const closing = Date.now();
  const closed = client.close();
  while (!isEnded() && Date.now() - closing < 1_500) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(isEnded(), `no session end within ${Date.now() - closing} ms`);
  await closed;
  await recall;
});

test('closing the connection ends the session: what it left is written for the next start', async (t) => {
  const client = await connected(t);
  await call(client, 'evolver_recall', { task: PROMPT });
  await client.close();
  const state = join(proxy.env.HOME, '.evolver', 'state');
  for (let tries = 0; tries < 50 && !readdirSync(state).includes('mcp-generic-reports-queue.jsonl'); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  const queued = readFileSync(join(state, 'mcp-generic-reports-queue.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).report);
  assert.ok(queued.some((report) => report.evidence.aborted));
});

test('evolver_login answers the link and code, and tells the agent to show them to the person and approve nothing', async (t) => {
  const isolated = await fakeProxy();
  const fakeDir = join(isolated.env.HOME, 'fake-evolver');
  const fake = installFakeEvolver(join(isolated.env.HOME, '.evolver', 'state', 'mcp-generic-engine'), fakeDir);
  const client = await connected(t, { ...isolated.env, ...fake.env });
  t.after(() => {
    const starts = readdirSync(fakeDir).includes('starts') ? readFileSync(join(fakeDir, 'starts'), 'utf8').trim().split('\n') : [];
    for (const line of starts) try { process.kill(Number(line.split(' ')[0]), 'SIGKILL'); } catch {}
    isolated.close();
  });
  const { tools } = await client.listTools();
  assert.match(tools.find((tool) => tool.name === 'evolver_login').description, /Show the link and code to the person verbatim; never open or approve it yourself\.$/);
  const answer = textOf(await call(client, 'evolver_login'));
  assert.match(answer, /^To sign in to the EvoMap Hub, open https:\/\/hub\.test\/device\?user_code=FAKE-CODE and enter the code FAKE-CODE\./);
});
