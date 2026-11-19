import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fileStoresOf } from '../../../lib/runtime/store/file-stores.js';
import { createClinePlugin } from '../../../hosts/cline/dist/plugin.js';
import { pack } from '../../../scripts/pack.mjs';
import { PROMPT, RECIPE, RECIPE_STEPS } from '../../app/memory-ports.js';
import { closeProxyWhenSettled, fakeProxy } from '../../helpers/fake-proxy.js';
import { useProcessHome } from '../../helpers/process-home.js';

const marker = '[Evolution Memory] Recipe: Stabilise flaky redis connection retries';
const packed = mkdtempSync(join(tmpdir(), 'evolver-cline-packed-'));
const ledgerCore = fileURLToPath(new URL('../../../node_modules/@evomap/evolver-core', import.meta.url));
after(() => rmSync(packed, { recursive: true, force: true }));
let bundle;

// The Cline 3.0.73 setup and hooks, loaded through the manifest included in the bundle.
async function packedHost(t) {
  if (!bundle) {
    pack('cline', packed);
    const { cline } = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8'));
    const [plugin] = cline.plugins;
    assert.deepEqual(plugin.capabilities, ['hooks', 'commands']);
    const [entry] = plugin.paths;
    const declared = await import(pathToFileURL(join(packed, entry)).href);
    assert.equal(typeof declared.default.setup, 'function');
    bundle = await import(pathToFileURL(join(packed, 'hosts/cline/dist/plugin.js')).href);
  }
  const proxy = await fakeProxy({ assets: [], recipes: [RECIPE], stepAssets: RECIPE_STEPS });
  const home = useProcessHome(proxy.env.HOME);
  const cwd = join(proxy.env.HOME, 'workspace');
  const dataDir = join(proxy.env.HOME, 'cline-data');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const env = {
    CLINE_DATA_DIR: dataDir, EVOMAP_PROXY_PORT: proxy.env.EVOMAP_PROXY_PORT,
    EVOLVER_RECALL: 'on', EVOLVER_AUTO_DISTILL: 'off', EVOLVER_HEADLESS: '',
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  let dispose;
  t.after(async () => {
    try {
      await dispose?.();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      home.restore();
      await closeProxyWhenSettled(proxy);
    }
  });
  const stores = fileStoresOf({ dir: join(dataDir, 'evolver-plugin'), agent: 'cline' });
  const modules = join(stores.folder('engine'), 'node_modules', '@evomap');
  mkdirSync(modules, { recursive: true });
  symlinkSync(ledgerCore, join(modules, 'evolver-core'), process.platform === 'win32' ? 'junction' : 'dir');
  const plugin = bundle.createClinePlugin();
  await plugin.setup({}, {
    cwd,
    session: { conversationId: 'conv_test' },
    onDispose: handler => { dispose = handler; },
  });
  return { hooks: plugin.hooks, proxy, stores };
}

const message = (id, role, text, metadata) => ({
  id, role, content: [{ type: 'text', text }], createdAt: Date.now(), ...(metadata && { metadata }),
});
const snapshot = (runId, messages, iteration = 0) => ({
  conversationId: 'conv_test', agentId: 'agent_test', runId, status: 'running',
  messages, iteration, pendingToolCalls: [],
});
const modelRequest = (state, signal) => ({
  snapshot: state, request: { messages: structuredClone(state.messages), ...(signal && { signal }) },
});
const finish = (state, status, answer) => ({
  snapshot: { ...state, status }, result: {
    runId: state.runId, agentId: state.agentId, status,
    messages: [...state.messages, message('answer-' + state.runId, 'assistant', answer)],
    outputText: answer,
  },
});
const promptMessage = (id, text) => message(id, 'user', `<user_input mode="act">${text}</user_input>`);

async function startRun(hooks, runId, prompt = PROMPT, history = []) {
  const opened = snapshot(runId, [...history, promptMessage('prompt-' + runId, prompt)]);
  await hooks.beforeRun({ snapshot: opened });
  await hooks.beforeModel(modelRequest(opened));
  return { ...opened, iteration: 1 };
}

test('the packed Cline plugin sends the Recipe only to model requests of the current user run', async t => {
  const { hooks, proxy } = await packedHost(t);
  const user = promptMessage('msg_1', PROMPT);
  const start = snapshot('run_1', [user]);
  await hooks.beforeRun({ snapshot: start });
  const reminder = message('msg_2', 'user', 'Complete the task.', { displayRole: 'system', userRunSpan: 0 });
  const state = snapshot(start.runId, [user, reminder]);
  const first = modelRequest(state);
  assert.match(JSON.stringify((await hooks.beforeModel(first))?.messages), /\[Evolution Memory\] Recipe: Stabilise flaky redis connection retries/);
  assert.deepEqual(first.request.messages, [user, reminder], 'outbound changes never enter native history');

  const later = modelRequest({ ...state, iteration: 2 });
  assert.ok(JSON.stringify((await hooks.beforeModel(later))?.messages).includes(marker));
  assert.equal(proxy.requests.filter(({ path }) => path === '/recipe/search').length, 1);

  const completed = finish(state, 'completed', 'The retry policy is documented.');
  await hooks.afterRun(completed);
  const next = snapshot('run_2', [...completed.result.messages, promptMessage('msg_3', 'Thanks!')]);
  await hooks.beforeRun({ snapshot: next });
  const nextRequest = modelRequest(next);
  const response = await hooks.beforeModel(nextRequest);
  assert.ok(!JSON.stringify(response?.messages ?? nextRequest.request.messages).includes(marker));
  const recalls = proxy.requests.filter(({ path }) => path === '/recipe/search');
  assert.equal(recalls.length, 1);
  assert.ok(JSON.stringify(recalls[0].body).includes(PROMPT));
});

test('direct input added after beforeRun supplies recall and a synthetic reminder does not', async t => {
  const { hooks, proxy } = await packedHost(t);
  const previous = message('old_prompt', 'user', PROMPT);
  previous.createdAt -= 60_000;
  const start = snapshot('run_direct', [previous]);
  await hooks.beforeRun({ snapshot: start });
  const reminder = message('reminder', 'user', 'Complete the task.', { userRunSpan: 0 });
  const waiting = snapshot(start.runId, [previous, reminder], 1);
  assert.equal(await hooks.beforeModel(modelRequest(waiting)), undefined);
  assert.equal(proxy.requests.filter(({ path }) => path === '/recipe/search').length, 0);

  const prompt = promptMessage('new_prompt', PROMPT);
  const ready = snapshot(start.runId, [previous, prompt, reminder], 1);
  assert.ok(JSON.stringify((await hooks.beforeModel(modelRequest(ready)))?.messages).includes(marker));
});

const checkCommand = 'node --test fixture.test.cjs';
const passingOutput = '✔ retry budget\nℹ tests 1\nℹ pass 1\nℹ fail 0\n';
const failingOutput = '[Command exited with code 1]\n✖ retry budget\nℹ tests 1\nℹ pass 0\nℹ fail 1\nCommand exited with code 1';

function shellCall(state, id, command = checkCommand) {
  const input = { commands: [command] };
  return { snapshot: state, toolCall: { toolName: 'run_commands', toolCallId: id, input }, input };
}

function shellResult(call, success = true, query = call.input.commands[0]) {
  return {
    ...call, result: {
      isError: false,
      output: [{ query, success, result: success ? passingOutput : failingOutput, ...(!success && { error: 'Command exited with code 1' }) }],
    },
  };
}

function lifecycleHost(t, handle) {
  const events = [];
  const warnings = [];
  const commands = new Map();
  const model = { capture: () => ({ configDigest: 'fixture-route', selection: { providerId: 'openai-compatible', modelId: 'fixture' } }) };
  const plugin = createClinePlugin({
    model,
    connect: () => ({
      handle: async (event, payload, options) => {
        events.push([event, payload.turnId]);
        return await handle(event, payload, options) ?? {};
      },
      close: () => {},
      idle: async () => {},
    }),
  });
  plugin.setup({ registerCommand: (command) => commands.set(command.name, command.handler) }, {
    cwd: tmpdir(), client: { name: 'cline-cli' }, session: { sessionId: 'conv_test' },
    onDispose: (dispose) => t.after(dispose), logger: { log: (message, metadata) => {
      if (typeof message === 'string') warnings.push({ message, metadata });
    } },
  });
  return { hooks: plugin.hooks, events, commands, warnings, model };
}

test('a superseded Cline run cannot open a turn after session initialization', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const { hooks, events } = lifecycleHost(t, async (event, { turnId }) => {
    if (event === 'session_start' && turnId === 'run_stale') {
      entered.resolve();
      await resume.promise;
    }
  });
  const stale = snapshot('run_stale', [promptMessage('stale', PROMPT)]);
  const current = snapshot('run_current', [promptMessage('current', PROMPT)]);
  const pending = hooks.beforeRun({ snapshot: stale });
  await entered.promise;
  const next = hooks.beforeRun({ snapshot: current });
  now += 10_001;
  resume.resolve();
  await Promise.all([pending, next]);
  assert.deepEqual(events, [['session_start', 'run_stale'], ['before_run', 'run_current']]);
});

test('a Cline abort during session initialization cannot open a turn', async t => {
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const { hooks, events } = lifecycleHost(t, async (event) => {
    if (event === 'session_start') {
      entered.resolve();
      await resume.promise;
    }
  });
  const state = snapshot('run_cancel_init', [promptMessage('cancelled', PROMPT)]);
  const pending = hooks.beforeRun({ snapshot: state });
  await entered.promise;
  await hooks.afterRun(finish(state, 'aborted', ''));
  resume.resolve();
  await pending;
  assert.deepEqual(events, [['session_start', 'run_cancel_init']]);
});

test('a failed Cline session start can be retried for the same run', async t => {
  let starts = 0;
  const { hooks, events } = lifecycleHost(t, (event, payload, options) => {
    if (event === 'session_start' && ++starts === 1) options?.onError?.(Object.assign(new Error('locked fixture'), { code: 'ELOCKED' }));
  });
  const state = snapshot('run_retry_init', [promptMessage('retry', PROMPT)], 1);
  await hooks.beforeRun({ snapshot: state });
  await hooks.beforeModel(modelRequest(state));
  assert.deepEqual(events, [['session_start', 'run_retry_init']]);
  await hooks.beforeRun({ snapshot: state });
  assert.deepEqual(events, [['session_start', 'run_retry_init'], ['session_start', 'run_retry_init'], ['before_run', 'run_retry_init']]);
});

test('an overlapping Cline draft request reports busy before or after the command prompt is queued', async t => {
  const response = Promise.withResolvers();
  const { hooks, events, commands, warnings, model } = lifecycleHost(t, (event) => {
    if (event === 'command') return response.promise;
  });
  const verified = await startRun(hooks, 'run_verified');
  const call = shellCall(verified, 'call_verified');
  await hooks.beforeTool(call);
  await hooks.afterTool(shellResult(call));
  const terminal = finish(verified, 'completed', 'The retry test passed.');
  terminal.result.messages.at(-1).modelInfo = { provider: 'openai-compatible', id: model.capture().selection.modelId };
  await hooks.afterRun(terminal);

  const request = commands.get('evolver-distill');
  const first = request('');
  const queued = request('');
  try {
    await hooks.beforeRun({ snapshot: snapshot('run_draft', [promptMessage('draft', first.submitPrompt)]) });
    assert.deepEqual(events.filter(([event]) => event === 'command'), [['command', 'run_draft']]);
    const later = request('');
    const stopped = await hooks.beforeRun({ snapshot: snapshot('run_busy', [promptMessage('busy', queued.submitPrompt)]) });
    assert.match(later, /already preparing a private draft/i);
    assert.deepEqual(stopped, { stop: true, reason: later });
    assert.deepEqual(warnings, [{ message: later, metadata: { severity: 'warn' } }]);
    assert.deepEqual(events.filter(([event]) => event === 'command'), [['command', 'run_draft']]);
  } finally {
    response.resolve({ ok: true });
  }
});

const reportRequests = (proxy) => proxy.requests.filter(({ path }) => path === '/asset/reuse-result');

async function noWork({ stores, proxy }) {
  assert.deepEqual(await stores.candidates.read(), {});
  assert.deepEqual(reportRequests(proxy), []);
  assert.equal(await stores.outbox.some(() => true), false);
}

async function waitForReports(proxy, count) {
  const deadline = Date.now() + 10_000;
  while (reportRequests(proxy).length < count && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(reportRequests(proxy).length, count, 'each Recipe step has exactly one result');
}

test('same toolCallId records pass and fail from the result row when the tool wrapper succeeds', async t => {
  for (const success of [true, false]) await t.test(success ? 'test passes' : 'test fails', async t => {
    const host = await packedHost(t);
    const state = await startRun(host.hooks, 'run_verdict');
    const call = shellCall(state, 'call_check');
    const receipt = shellResult(call, success);
    await host.hooks.beforeTool(call);
    await host.hooks.afterTool(receipt);
    await host.hooks.afterTool(receipt);
    await noWork(host);

    const completed = finish(state, 'completed', success ? 'The Redis retry test passed.' : 'The retry test failed.');
    await host.hooks.afterRun(completed);
    await host.hooks.afterRun(completed);
    await waitForReports(host.proxy, 2);
    assert.deepEqual(reportRequests(host.proxy).map(({ body }) => [body.outcome, body.evidence.check.passed]), Array(2).fill([
      success ? 'success' : 'failed', success,
    ]));
    const turns = Object.values(await host.stores.candidates.read()).flatMap(({ turns }) => turns);
    assert.equal(turns.length, 1);
    const checks = turns[0].steps.filter(({ kind }) => kind === 'check');
    assert.equal(checks.length, 1, 'replayed results and terminal cannot duplicate a check');
    assert.equal(checks[0].command, checkCommand);
    assert.equal(checks[0].failed, !success);
    assert.equal(checks[0].exit, success ? null : 1, 'a check keeps only an observed exit code');
  });
});

test('the packed plugin leaves mismatched and conflicting test receipts unverified', async t => {
  for (const scenario of ['wrong ID', 'wrong run', 'wrong command', 'wrapper error', 'conflicting duplicate']) await t.test(scenario, async t => {
    const host = await packedHost(t);
    const state = await startRun(host.hooks, 'run_unverified');
    const call = shellCall(state, 'call_pending');
    await host.hooks.beforeTool(call);
    if (scenario === 'wrong ID') await host.hooks.afterTool(shellResult(shellCall(state, 'call_unrelated')));
    if (scenario === 'wrong run') await host.hooks.afterTool(shellResult({ ...call, snapshot: { ...state, runId: 'run_stale' } }));
    if (scenario === 'wrong command') await host.hooks.afterTool(shellResult(call, true, 'echo not-the-check'));
    if (scenario === 'wrapper error') {
      const receipt = shellResult(call);
      await host.hooks.afterTool({ ...receipt, result: { ...receipt.result, isError: true } });
    }
    if (scenario === 'conflicting duplicate') {
      await host.hooks.afterTool(shellResult(call));
      await host.hooks.afterTool(shellResult(call, false));
    }
    await host.hooks.afterRun(finish(state, 'completed', 'The retries are fixed.'));
    await noWork(host);
  });
});

test('an undelivered Recipe stays available for a new prompt in the same Cline session', async t => {
  const host = await packedHost(t);
  const state = snapshot('run_without_delivery', [promptMessage('omitted_prompt', PROMPT)]);
  await host.hooks.beforeRun({ snapshot: state });
  assert.ok(host.proxy.requests.some(({ path }) => path === '/recipe/search'));
  const request = modelRequest({ ...state, messages: [], iteration: 1 });
  assert.equal(await host.hooks.beforeModel(request), undefined);
  const call = shellCall(state, 'call_after_missing_recipe');
  await host.hooks.beforeTool(call);
  await host.hooks.afterTool(shellResult(call));
  const completed = finish(state, 'completed', 'The test passed.');
  await host.hooks.afterRun(completed);
  await noWork(host);
  const retry = snapshot('run_retry_delivery', [...completed.result.messages, promptMessage('retry_prompt', PROMPT)]);
  await host.hooks.beforeRun({ snapshot: retry });
  const reply = await host.hooks.beforeModel(modelRequest(retry));
  assert.ok(JSON.stringify(reply?.messages ?? []).includes(marker), 'the missed Recipe must reach the next prompt');
});

test('a native steering prompt ends Recipe attribution for the original input', async t => {
  for (const mode of ['act', 'plan', 'yolo', 'terminal only']) await t.test(mode, async t => {
    const host = await packedHost(t);
    const state = await startRun(host.hooks, 'run_steered');
    const call = shellCall(state, 'call_before_steer');
    await host.hooks.beforeTool(call);
    await host.hooks.afterTool(shellResult(call));
    const steer = message('native_steer', 'user', `<user_input mode="${mode === 'terminal only' ? 'act' : mode}">Change direction.</user_input>`,
      { userRunSpan: 0 });
    const steered = { ...state, messages: [...state.messages, steer], iteration: 2 };
    if (mode !== 'terminal only') {
      const request = modelRequest(steered);
      const reply = await host.hooks.beforeModel(request);
      assert.ok(!JSON.stringify(reply?.messages ?? request.request.messages).includes(marker), 'the old Recipe belongs to the original prompt');
    }
    await host.hooks.afterRun(finish(steered, 'completed', 'The unrelated parsing task is complete.'));
    await noWork(host);
  });
});

test('Cline without a configured distillation route still keeps successive verified turns', async t => {
  const host = await packedHost(t);
  let history = [];
  for (let index = 1; index <= 2; index++) {
    const state = await startRun(host.hooks, `run_unbound_${index}`, PROMPT, history);
    const call = shellCall(state, `call_unbound_${index}`);
    await host.hooks.beforeTool(call);
    await host.hooks.afterTool(shellResult(call));
    const ended = finish(state, 'completed', 'The retry test passed.');
    await host.hooks.afterRun(ended);
    history = ended.result.messages;
  }
  const [range] = Object.values(await host.stores.candidates.read());
  assert.equal(range.model, null);
  assert.deepEqual(range.turns.map(({ turn }) => turn), [1, 2]);
});

test('aborted and superseded native runs with a passing test cannot record work', async t => {
  for (const scenario of ['Ctrl-C', 'terminal missing']) await t.test(scenario, async t => {
    const host = await packedHost(t);
    const state = await startRun(host.hooks, 'run_cancel');
    const call = shellCall(state, 'call_pass_before_cancel');
    await host.hooks.beforeTool(call);
    await host.hooks.afterTool(shellResult(call));
    await noWork(host);

    // A partial answer may already exist when Windows delivers Ctrl-C after a successful shell call.
    const answer = 'The test passed earlier.';
    if (scenario === 'Ctrl-C') await host.hooks.afterRun(finish(state, 'aborted', answer));
    else {
      const history = [...state.messages, message('partial', 'assistant', answer)];
      await startRun(host.hooks, 'run_after_cancel', 'Thanks!', history);
    }
    await host.hooks.afterRun(finish(state, 'completed', answer));
    await noWork(host);
  });
});
