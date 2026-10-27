import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { pack } from '../../../scripts/pack.mjs';
import { PROMPT } from '../../app/memory-ports.js';
import { fakeProxy } from '../../helpers/fake-proxy.js';

// Claude Code loads the packed folder's `hooks/register.ts` with its engine as `$`. Here the module runs over a
// stand-in engine whose processes, network and clock are real, so it starts the packed relay and talks to it.

const { captured } = JSON.parse(readFileSync(new URL('../../fixtures/claude-code/events.json', import.meta.url), 'utf8'));
const GENE = { title: 'Stabilise Redis retries', summary: 'Flaky Redis-backed tests stop failing once retries are unbounded and the client is shared.', strategy: ['Set maxRetriesPerRequest to null', 'Share one client', 'Close it in teardown'] };
const DRAFTED = {
  ok: true, status: 'draft', distill_id: 'd'.repeat(16), quality: { ok: true, score: 6, threshold: 5 },
  gene: { type: 'Gene', asset_id: 'sha256:' + 'g'.repeat(64), summary: GENE.summary },
  capsule: { type: 'Capsule', asset_id: 'sha256:' + 'c'.repeat(64), summary: GENE.summary },
};
const USAGE = { input_tokens: 1_200, output_tokens: 800 };

const root = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-claude-code-packed-')));
after(() => rmSync(root, { recursive: true, force: true }));
pack('claude-code', root);
writeFileSync(join(root, 'hooks', 'register.mjs'), stripTypeScriptTypes(readFileSync(join(root, 'hooks', 'register.ts'), 'utf8')));

let loads = 0;

function streamOf(child) {
  const pieces = [];
  let wake = () => {};
  let isDone = false;
  const push = (stream) => (chunk) => {
    pieces.push({ stream, text: String(chunk) });
    wake();
  };
  child.stdout.on('data', push('stdout'));
  child.stderr.on('data', push('stderr'));
  child.on('close', () => {
    isDone = true;
    wake();
  });
  return (async function* pieced() {
    while (!isDone || pieces.length > 0) {
      if (pieces.length > 0) yield pieces.shift();
      else await new Promise((resolve) => { wake = resolve; });
    }
  })();
}

/** A Claude Code session over the packed module: `call(event, input, ran)` raises a hook as the engine does. */
async function session(t, { options = { node_path: process.execPath } } = {}) {
  const proxy = await fakeProxy({ distillAnswer: DRAFTED });
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-claude-code-project-')));
  mkdirSync(join(project, 'lib'));
  writeFileSync(join(project, 'lib', 'redis.js'), 'export const retries = 3;\n');
  const children = [];
  t.after(() => {
    for (const child of children) child.kill('SIGKILL');
    proxy.close();
    rmSync(project, { recursive: true, force: true });
  });
  const seen = { appended: [], toasts: [], submitted: [], commands: [], completions: [] };
  const $ = {
    plugin: { name: 'evolver-agent-plugin', root },
    session: {
      id: async () => captured.session.id,
      cwd: async () => project,
      model: async () => captured.session.model,
      append: async ({ message }) => { seen.appended.push(message.content[0].text); },
    },
    fs: { stat: async (path) => ({ realPath: path }) },
    http: {
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        return { ok: response.ok, status: response.status, text: await response.text() };
      },
    },
    clock: { sleep: (ms, { signal } = {}) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); });
    }) },
    process: {
      spawn: ({ argv, env }) => {
        const child = spawn(argv[0], argv.slice(1), { env: { ...proxy.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(child);
        return streamOf(child);
      },
    },
    model: { complete: async (request) => {
      seen.completions.push(request);
      return { isAnswered: true, text: JSON.stringify(GENE), usage: { input_tokens: 900, output_tokens: 120 } };
    } },
    command: { register: async (spec) => { seen.commands.push(spec); } },
    prompt: { submit: async ({ text }) => { seen.submitted.push(text); } },
    ui: { toast: (text) => { seen.toasts.push(text); } },
  };
  loads += 1;
  const { register } = await import(`${pathToFileURL(join(root, 'hooks', 'register.mjs')).href}?load=${loads}`);
  const handlers = new Map();
  register((event, handler) => {
    handlers.set(event, handler);
    return { catch() {} };
  }, options);
  const call = (event, input = {}, ran = () => ({})) => handlers.get(event)($, input, Object.assign(async (value) => ran(value), { signal: new AbortController().signal }));
  return { call, seen, proxy, project, children };
}

async function until(read, what, deadlineMs = 10_000) {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() - start > deadlineMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const reuseReports = (proxy) => proxy.requests.filter((request) => request.path === '/asset/reuse-result').map((request) => request.body);

async function verifiedTurn(cc, turnId = 't1') {
  await cc.call('prompt.submit', { ...captured.promptSubmit, text: PROMPT, origin: { kind: 'composer' } });
  await cc.call('turn.start', { text: PROMPT, turnId });
  await cc.call('tool.call', { tool: 'Edit', file_path: join(cc.project, 'lib', 'redis.js'), old_string: '3', new_string: 'null', tool_use_id: `${turnId}-edit` }, () => {
    writeFileSync(join(cc.project, 'lib', 'redis.js'), 'export const retries = null;\n');
    return { ref: 1, text: 'The file has been updated.' };
  });
  await cc.call('tool.call', { tool: 'Bash', command: 'npm test', tool_use_id: `${turnId}-test` }, () => ({ ref: 2, text: '# pass 3\n# fail 0' }));
  return cc.call('turn.complete', { answer: 'Retries are unbounded now; npm test passes.', durationMs: 900, isAborted: false, turnId, reason: 'answer', usage: USAGE }, () => ({ text: '', usage: USAGE }));
}

test('a session starts the relay, registers the commands, and a whole turn is recalled for, reported and summarised', async (t) => {
  const cc = await session(t);
  await cc.call('session.start', captured.sessionStart);
  assert.deepEqual(cc.children.length, 1);
  const names = cc.seen.commands.map((command) => command.name);
  for (const name of ['evolver-status', 'evolver-search', 'evolver-distill', 'evolver-drafts', 'evolver-evolve']) assert.ok(names.includes(name), name);

  const ended = await verifiedTurn(cc);
  assert.match(cc.seen.appended[0], /^\[Evolution Memory\] Fix flaky Redis connection retries[\s\S]*Apply them where they fit\.$/);
  assert.match(ended.text, /^✓ Goal reached \(last check passed: npm test\) · reused EvoMap strategy "Fix flaky Redis connection retries"/);
  const [report] = await until(() => reuseReports(cc.proxy).length > 0 && reuseReports(cc.proxy), 'the reuse report');
  assert.deepEqual(
    [report.task_id, report.outcome, report.evidence.tier, report.evidence.applied, report.evidence.check],
    [`claude-code:${captured.session.id}:1`, 'success', 'L1', 'used', { kind: 'test', passed: true, fail_then_pass: false }],
  );
});

test('the relay\'s distillation runs on the session\'s own model through the module, and becomes a draft', async (t) => {
  const cc = await session(t);
  await cc.call('session.start', captured.sessionStart);
  await verifiedTurn(cc);
  const answer = await cc.call('command.run', { command: 'evolver-distill', args: '', origin: { kind: 'composer' } });
  assert.match(answer.text, /Distilled "Stabilise Redis retries" into a draft/);
  assert.equal(cc.seen.completions[0].model, captured.session.model);
  assert.match(cc.seen.completions[0].prompt, /npm test/);
  const { body } = cc.proxy.requests.find((request) => request.path === '/conversation/distill');
  assert.deepEqual([body.platform, body.persist, body.publish], ['claude-code', true, false]);
});

test('commands answer as Claude Code shows them: evolve is sent as a prompt, others answer text, foreign ones pass on', async (t) => {
  const cc = await session(t);
  await cc.call('session.start', captured.sessionStart);
  assert.deepEqual(await cc.call('command.run', { command: 'evolver-evolve', args: 'the retries' }), {});
  assert.match(cc.seen.submitted[0], /^Take a deliberate evolution step[\s\S]*Focus on: the retries$/);
  assert.match((await cc.call('command.run', { command: 'evolver-drafts', args: '' })).text, /No distilled drafts are waiting/);
  assert.deepEqual(await cc.call('command.run', { command: 'compact', args: '' }, () => ({ text: 'core' })), { text: 'core' });
});

test('a prompt nobody typed opens no turn, and a relay that died is started again by the next event', async (t) => {
  const cc = await session(t);
  await cc.call('session.start', captured.sessionStart);
  await cc.call('prompt.submit', { text: PROMPT, wait: false, origin: { kind: 'task-notification' } });
  await cc.call('turn.start', { text: PROMPT, turnId: 't-note' });
  assert.deepEqual(cc.seen.appended, []);
  cc.children[0].kill('SIGKILL');
  await until(() => cc.children[0].exitCode !== null || cc.children[0].signalCode !== null, 'the relay to exit');
  await new Promise((resolve) => setTimeout(resolve, 50));
  await cc.call('prompt.submit', { ...captured.promptSubmit, text: PROMPT });
  await cc.call('turn.start', { text: PROMPT, turnId: 't2' });
  assert.equal(cc.children.length, 2);
  assert.match(cc.seen.appended[0], /^\[Evolution Memory\]/);
});

test('a session end closes its open turn as aborted and reports the strategy it held', async (t) => {
  const cc = await session(t);
  await cc.call('session.start', captured.sessionStart);
  await cc.call('prompt.submit', { ...captured.promptSubmit, text: PROMPT });
  await cc.call('turn.start', { text: PROMPT, turnId: 't1' });
  await cc.call('session.end', captured.sessionEnd);
  const [report] = await until(() => reuseReports(cc.proxy).length > 0 && reuseReports(cc.proxy), 'the aborted report');
  assert.deepEqual([report.task_id, report.evidence.aborted], [`claude-code:${captured.session.id}:1`, true]);
});
