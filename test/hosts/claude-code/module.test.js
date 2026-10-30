import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { pack } from '../../../scripts/pack.mjs';
import { ASSET, PROMPT } from '../../app/memory-ports.js';
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
async function session(t, { options = { node_path: process.execPath }, spawnOf, delays, assets } = {}) {
  const proxy = await fakeProxy({ distillAnswer: DRAFTED, delays, ...(assets && { assets }) });
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
    plugin: { name: 'evolver-plugin', root },
    session: {
      id: async () => captured.session.id,
      cwd: async () => project,
      model: async () => captured.session.model,
      append: async ({ message }) => { seen.appended.push(message.content[0].text); },
    },
    fs: { stat: async (path) => ({ realPath: path }), read: async (path) => readFileSync(path, 'utf8') },
    http: {
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        return { ok: response.ok, status: response.status, text: await response.text() };
      },
    },
    clock: { now: async () => Date.now(), sleep: (ms, { signal } = {}) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); });
    }) },
    process: {
      spawn: spawnOf ?? (({ argv, env }) => {
        const child = spawn(argv[0], argv.slice(1), { env: { ...proxy.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(child);
        return streamOf(child);
      }),
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
  // A model step streams: the hook is a generator over the steps beneath it, which here answer nothing.
  const step = async (turnId, index = 0) => {
    const beneath = async function* stepped() { return {}; };
    for await (const chunk of handlers.get('turn.step')($, { turnId, index, model: captured.session.model, messageCount: 3 }, beneath)) void chunk;
  };
  return { call, step, seen, proxy, project, children };
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

// The recall lands after `turn.start`; the turn's next model step carries the strategy, and books it.
async function recalledTurn(cc, turnId = 't1') {
  await cc.call('prompt.submit', { ...captured.promptSubmit, text: PROMPT, origin: { kind: 'composer' } });
  const before = cc.seen.appended.length;
  await cc.call('turn.start', { text: PROMPT, turnId });
  await until(() => cc.seen.appended.length > before, 'the strategy to land');
  await cc.step(turnId, 0);
  await cc.step(turnId, 1);
}

async function verifiedTurn(cc, turnId = 't1') {
  await recalledTurn(cc, turnId);
  await cc.call('tool.call', { tool: 'Edit', file_path: join(cc.project, 'lib', 'redis.js'), old_string: '3', new_string: 'null', tool_use_id: `${turnId}-edit` }, () => {
    writeFileSync(join(cc.project, 'lib', 'redis.js'), 'export const retries = null;\n');
    return { ref: 1, text: 'The file has been updated.' };
  });
  await cc.call('tool.call', { tool: 'Bash', command: 'npm test', description: 'Run the tests', tool_use_id: `${turnId}-test` }, () => ({ ref: 2, text: '# pass 3\n# fail 0' }));
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
  assert.match(ended.text, /^✓ Goal reached \(last check passed: Run the tests\) · reused EvoMap strategy "Fix flaky Redis connection retries"/);
  const state = join(cc.proxy.env.HOME, '.evolver', 'state');
  const [sessionFile] = readdirSync(state).filter((name) => /^claude-code-session-.*\.json$/.test(name));
  assert.equal(JSON.parse(readFileSync(join(state, sessionFile), 'utf8')).pid, process.pid, 'the session belongs to Claude Code, the relay\'s parent');
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

test('a module loaded again without a session start still answers its commands', async (t) => {
  const cc = await session(t);
  assert.match((await cc.call('command.run', { command: 'evolver-drafts', args: '' })).text, /No distilled drafts are waiting/);
  assert.equal(cc.seen.commands.length, 0);
});

test('the commands the module registers are the plugin\'s, as the relay knows them', async () => {
  const { commandCatalog } = await import('../../../lib/channels/plugin/adapter.js');
  const shipped = JSON.parse(readFileSync(join(root, 'hooks', 'commands.json'), 'utf8'));
  assert.deepEqual(shipped, commandCatalog.map(({ name, description, hint }) => ({ name, description, ...(hint && { hint }) })));
});

test('a prompt nobody typed is recalled for nothing, and a relay that died is started again by the next event', async (t) => {
  const cc = await session(t);
  await cc.call('session.start', captured.sessionStart);
  await cc.call('prompt.submit', { text: PROMPT, wait: false, origin: { kind: 'task-notification' } });
  await cc.call('turn.start', { text: PROMPT, turnId: 't-note' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(cc.seen.appended, []);
  assert.deepEqual(cc.proxy.requests.filter((request) => request.path === '/asset/fetch'), []);
  cc.children[0].kill('SIGKILL');
  await until(() => cc.children[0].exitCode !== null || cc.children[0].signalCode !== null, 'the relay to exit');
  await new Promise((resolve) => setTimeout(resolve, 50));
  await recalledTurn(cc, 't2');
  assert.equal(cc.children.length, 2);
  assert.match(cc.seen.appended[0], /^\[Evolution Memory\]/);
});

test('a strategy that lands after the turn\'s last model step is added but never booked or reported', async (t) => {
  const cc = await session(t);
  await cc.call('session.start', captured.sessionStart);
  await cc.call('prompt.submit', { ...captured.promptSubmit, text: PROMPT, origin: { kind: 'composer' } });
  await cc.call('turn.start', { text: PROMPT, turnId: 't1' });
  await until(() => cc.seen.appended.length > 0, 'the strategy to land');
  await cc.call('turn.complete', { answer: 'Done.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' }, () => ({ text: '' }));
  await cc.step('t1', 1);
  await cc.call('prompt.submit', { ...captured.promptSubmit, text: 'and the readme', origin: { kind: 'composer' } });
  await cc.call('turn.start', { text: 'and the readme', turnId: 't2' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(reuseReports(cc.proxy), []);
});

test('a session end closes its open turn as aborted and reports the strategy it held', async (t) => {
  const cc = await session(t);
  await cc.call('session.start', captured.sessionStart);
  await recalledTurn(cc, 't1');
  await cc.call('session.end', captured.sessionEnd);
  const [report] = await until(() => reuseReports(cc.proxy).length > 0 && reuseReports(cc.proxy), 'the aborted report');
  assert.deepEqual([report.task_id, report.evidence.aborted], [`claude-code:${captured.session.id}:1`, true]);
});

test('a recall that lands after its turn ended is not added, and the next turn may recall it afresh', async (t) => {
  const cc = await session(t, { delays: { '/asset/fetch': 800 } });
  await cc.call('session.start', captured.sessionStart);
  await cc.call('prompt.submit', { ...captured.promptSubmit, text: PROMPT, origin: { kind: 'composer' } });
  await cc.call('turn.start', { text: PROMPT, turnId: 't1' });
  await cc.call('turn.complete', { answer: 'Quick answer.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' }, () => ({ text: '' }));
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.deepEqual(cc.seen.appended, []);
  await recalledTurn(cc, 't2');
  assert.equal(cc.seen.appended.length, 1);
});

test('a relay that never starts is ended after the wait, and not started again on every event', async (t) => {
  const started = [];
  // As the engine's spawn stream: `return()` ends the child at once, even while a read waits.
  const silent = () => {
    const stream = {
      ended: false,
      next: () => new Promise(() => {}),
      return: async () => { stream.ended = true; return { done: true, value: undefined }; },
      [Symbol.asyncIterator]() { return stream; },
    };
    started.push(stream);
    return stream;
  };
  const cc = await session(t, { spawnOf: silent });
  const before = Date.now();
  await cc.call('session.start', captured.sessionStart);
  assert.ok(Date.now() - before >= 14_000, 'the start waited for the relay');
  assert.equal(started[0].ended, true, 'the silent relay was ended');
  assert.ok(cc.seen.commands.length > 0, 'the commands registered anyway');
  const next = Date.now();
  await cc.call('turn.start', { text: PROMPT, turnId: 't1' });
  await cc.call('session.end', captured.sessionEnd);
  assert.ok(Date.now() - next < 1_000, 'later events do not wait for a relay that failed to start');
  assert.equal(started.length, 1);
});

const STUCK_ASSET = {
  asset_id: 'sha256:' + 'b'.repeat(64),
  short_title: 'Retry assertions after an unbounded retry budget',
  summary: 'An AssertionError on retry counts after maxRetriesPerRequest is null means the test pins the old budget',
  signals_match: ['AssertionError', 'maxRetriesPerRequest', 'retries'],
  strategy: ['Read the assertion that pins the retry count', 'Compare it with the client option the change set', 'Update the expectation, not the client', 'Rerun the failing test before the suite'],
};

test('a failed check recalls for its output and hands the strategy to the model in the call\'s result context', async (t) => {
  const cc = await session(t, { assets: [ASSET, STUCK_ASSET] });
  await cc.call('session.start', captured.sessionStart);
  await recalledTurn(cc);
  await cc.call('tool.call', { tool: 'Edit', file_path: join(cc.project, 'lib', 'redis.js'), old_string: 'retries = 3', new_string: 'maxRetriesPerRequest = null', tool_use_id: 'e1' }, () => ({ ref: 1, text: 'The file has been updated.' }));

  const failed = await cc.call('tool.call', { tool: 'Bash', command: 'npm test', tool_use_id: 'c1' }, () => ({ ref: 2, isError: true, text: 'AssertionError: expected 3 to equal null' }));
  const passed = await cc.call('tool.call', { tool: 'Bash', command: 'npm test', tool_use_id: 'c2' }, () => ({ ref: 3, text: '# pass 3\n# fail 0' }));

  assert.equal(failed.context.length, 1);
  assert.match(failed.context[0], /^\[Evolution Memory\] Retry assertions after an unbounded retry budget[\s\S]*Apply them where they fit\.$/);
  assert.equal(failed.text, 'AssertionError: expected 3 to equal null');
  assert.equal(passed.context, undefined);
  const stuckRecall = cc.proxy.requests.find((request) => request.body?.context?.trigger === 'check_failed');
  assert.deepEqual(stuckRecall.body, {
    text: 'changed: maxRetriesPerRequest | AssertionError: expected 3 to equal null | files: redis.js',
    context: { task: PROMPT, trigger: 'check_failed', language: ['JavaScript'] },
  });
});
