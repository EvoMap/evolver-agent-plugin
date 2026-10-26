// A stand-in for OpenCode 1.19.4 around the plugin's entries: the SDK client a server plugin is handed (v1 call
// shapes), a loopback Proxy with a scratch HOME, and a driver that fires the hooks the way OpenCode's prompt loop
// does (session/prompt.ts, session/processor.ts, session/status.ts).

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ASSET, PROMPT } from '../../app/memory-ports.js';

export { ASSET, PROMPT };

export const GENE = JSON.stringify({ title: 'Stabilise Redis retries', summary: 'Make a flaky Redis client retry deterministically.', strategy: ['Find the retry option.', 'Set it explicitly.'] });

const DRAFTED = { ok: true, distill_id: 'distill_1', quality: { ok: true, score: 0.9 }, gene: { asset_id: 'sha256:gene' }, capsule: { asset_id: 'sha256:capsule', summary: 'Retry Redis deterministically.' } };

function defaultAnswer(path, body, assets) {
  if (path === '/asset/fetch') return { assets };
  if (path === '/proxy/status') return { running: true, status: 'running', node_id: 'node_test' };
  if (path === '/conversation/distill') return DRAFTED;
  return { recorded: true };
}

/** A loopback Proxy whose settings live in a scratch HOME the plugin is pointed at through `process.env`. */
export async function startProxy(t, { assets = [ASSET], answer = defaultAnswer } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) : undefined;
      requests.push({ path: request.url, body: parsed });
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer(request.url, parsed, assets)));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = mkdtempSync(join(tmpdir(), 'evolver-opencode-home-'));
  mkdirSync(join(home, '.evolver'));
  writeFileSync(join(home, '.evolver', 'settings.json'), JSON.stringify({ proxy: { url: `http://127.0.0.1:${server.address().port}`, version: '2.0.46' } }));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: home, USERPROFILE: home });
  t.after(() => {
    server.close();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(home, { recursive: true, force: true });
  });
  return { requests, home, stateDir: join(home, '.evolver', 'state') };
}

export const requestsTo = (proxy, path) => proxy.requests.filter((request) => request.path === path);
export const reportsOf = (proxy) => requestsTo(proxy, '/asset/reuse-result').map((request) => request.body);

export async function until(condition, what, deadlineMs = 10_000) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > deadlineMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

export const projectDirectory = () => realpathSync(mkdtempSync(join(tmpdir(), 'evolver-opencode-project-')));

export const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

/** The v1 SDK client: `sessions` is what `session.get` knows, `answer` what the helper session's model writes. */
export function fakeClient({ sessions = {}, answer = GENE } = {}) {
  const calls = [];
  const record = (name) => async (options) => {
    calls.push({ name, options });
    return { data: {} };
  };
  const client = {
    calls,
    answer,
    hold: undefined,
    session: {
      get: async ({ path }) => ({ data: sessions[path.id] ?? { id: path.id } }),
      create: async (options) => {
        calls.push({ name: 'create', options });
        return { data: { id: `ses_helper${calls.length}`, ...options.body } };
      },
      update: record('update'),
      abort: record('abort'),
      delete: record('delete'),
      prompt: async (options) => {
        calls.push({ name: 'prompt', options });
        await client.hold;
        return { data: { info: { role: 'assistant', tokens: { input: 900, output: 120 } }, parts: [{ type: 'text', text: client.answer }] } };
      },
    },
    tui: { showToast: async (options) => { calls.push({ name: 'toast', options }); return { data: true }; } },
  };
  return client;
}

export const callsNamed = (client, name) => client.calls.filter((call) => call.name === name);

export async function loadServer({ client = fakeClient(), directory = projectDirectory(), options = {} } = {}) {
  const { default: plugin } = await import('../../../hosts/opencode/dist/server.mjs');
  const hooks = await plugin.server({ client, directory, worktree: directory, project: {} }, options);
  return { plugin, hooks, client, directory };
}

let nextMessage = 0;

export function host(hooks) {
  const event = (type, properties) => hooks.event({ event: { type, properties } });
  return {
    event,
    async prompt(sessionID, text, extraParts = []) {
      nextMessage += 1;
      const output = { message: { id: `msg_${String(nextMessage).padStart(4, '0')}`, role: 'user', sessionID }, parts: [{ id: 'prt_0', type: 'text', text }, ...extraParts] };
      await hooks['chat.message']({ sessionID }, output);
      await event('session.status', { sessionID, status: { type: 'busy' } });
      return output;
    },
    async tool(sessionID, tool, args, result = { title: '', output: '', metadata: {} }) {
      await hooks['tool.execute.before']({ tool, sessionID, callID: 'call' }, { args });
      await hooks['tool.execute.after']({ tool, sessionID, callID: 'call', args }, result);
    },
    bash(sessionID, command, { exit = 0, output = '' } = {}) {
      return this.tool(sessionID, 'bash', { command }, { title: command, output, metadata: { exit, output, truncated: false } });
    },
    async answer(sessionID, text, { messageID = `msg_a${nextMessage}`, finish = 'stop', error } = {}) {
      const info = { id: messageID, sessionID, role: 'assistant', providerID: 'anthropic', modelID: 'claude-sonnet', finish, ...(error && { error }) };
      await event('message.updated', { sessionID, info: { ...info, finish: undefined } });
      if (text) await hooks['experimental.text.complete']({ sessionID, messageID, partID: 'prt_t' }, { text });
      await event('message.updated', { sessionID, info });
    },
    async idle(sessionID) {
      await event('session.status', { sessionID, status: { type: 'idle' } });
      await event('session.idle', { sessionID });
    },
  };
}

/** A turn that edited a file and ended on a passing check: the kind that becomes the session's candidate. */
export async function verifiedTurn(oc, sessionID, prompt = PROMPT) {
  await oc.prompt(sessionID, prompt);
  await oc.tool(sessionID, 'edit', { filePath: 'lib/redis.js', oldString: 'a', newString: 'maxRetriesPerRequest: null' });
  await oc.bash(sessionID, 'npm test 2>&1 | tail -5', { exit: 0, output: 'ℹ pass 4\nℹ fail 0' });
  await oc.answer(sessionID, 'Set maxRetriesPerRequest to null; the suite passes.');
  await oc.idle(sessionID);
}
