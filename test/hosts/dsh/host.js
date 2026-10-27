// A stand-in for DeepSeek Harness 0.2 around the packed plugin: a dsh profile whose node_modules links the packed
// folder (as `dsh plugin add` does), cordis's loading of it (unwrap the module, validate its config through its
// Standard Schema, `apply(ctx, config)`), and an agent loop that raises the events in the order the probe captured
// them in test/fixtures/dsh/payloads.json.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { pathToFileURL } from 'node:url';

import { pack } from '../../../scripts/pack.mjs';
import { fakeProxy } from '../../helpers/fake-proxy.js';
import { ASSET, PROMPT } from '../../app/memory-ports.js';

export { ASSET, PROMPT };
export const DSH = JSON.parse(readFileSync(new URL('../../fixtures/dsh/payloads.json', import.meta.url), 'utf8'));
export const GENE = JSON.stringify({ title: 'Stabilise Redis retries', summary: 'Make a flaky Redis client retry deterministically.', strategy: ['Find the retry option.', 'Set it explicitly.'] });
export const DRAFTED = { ok: true, distill_id: 'distill_1', quality: { ok: true, score: 0.9 }, gene: { asset_id: 'sha256:gene' }, capsule: { asset_id: 'sha256:capsule', summary: 'Retry Redis deterministically.' } };

const PACKAGE = '@evomap/dsh-evolver';
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;
const scratch = [];
after(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

let profileDir = null;

/** A dsh profile with the packed folder linked in, the way `dsh plugin --profile <p> add -w <folder>` leaves it. */
export function packedProfile() {
  if (profileDir) return profileDir;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-dsh-profile-')));
  scratch.push(root);
  pack('dsh', join(root, 'packed'));
  const profile = join(root, 'profiles', 'headless');
  mkdirSync(join(profile, 'node_modules', '@evomap'), { recursive: true });
  symlinkSync(join(root, 'packed'), join(profile, 'node_modules', PACKAGE), 'dir');
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-headless', private: true, dependencies: { [PACKAGE]: `link:${join(root, 'packed')}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', PACKAGE] } } }));
  profileDir = profile;
  return profile;
}

export function resolvedPackage() {
  const require = createRequire(join(packedProfile(), 'package.json'));
  const main = require.resolve(PACKAGE);
  return { main, manifestPath: require.resolve(`${PACKAGE}/package.json`), dir: dirname(require.resolve(`${PACKAGE}/package.json`)) };
}

/** What cordis-plugin-loader does with an entry `name: '@evomap/dsh-evolver'`: import it and unwrap its exports. */
export async function loadPlugin() {
  const exports = await import(pathToFileURL(resolvedPackage().main).href);
  const unwrapped = exports.default ?? exports;
  return unwrapped.__esModule ? unwrapped.default ?? unwrapped : unwrapped;
}

export function validatedConfig(plugin, config) {
  const result = plugin.Config['~standard'].validate(config);
  if (result.issues) throw new Error(result.issues.map((issue) => issue.message).join('; '));
  return result.value;
}

export async function startProxy(t, options = {}) {
  const proxy = await fakeProxy({ distillAnswer: DRAFTED, ...options });
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, EVOMAP_PROXY_PORT: process.env.EVOMAP_PROXY_PORT, EVOLVER_RECALL: process.env.EVOLVER_RECALL };
  Object.assign(process.env, { HOME: proxy.env.HOME, USERPROFILE: proxy.env.HOME });
  delete process.env.EVOMAP_PROXY_PORT;
  delete process.env.EVOLVER_RECALL;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    proxy.close();
  });
  return { ...proxy, home: proxy.env.HOME, port: Number(proxy.env.EVOMAP_PROXY_PORT), stateDir: join(proxy.env.HOME, '.evolver', 'state') };
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

export const projectDirectory = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-dsh-project-')));
  scratch.push(dir);
  return dir;
};

export const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

export function stateFile(proxy, name, empty = {}) {
  try {
    return JSON.parse(readFileSync(join(proxy.stateDir, name), 'utf8'));
  } catch {
    return empty;
  }
}

export function reportsQueued(proxy) {
  let queued = [];
  try {
    queued = readFileSync(join(proxy.stateDir, 'dsh-reports-queue.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).report);
  } catch {
  }
  return [...queued, ...Object.values(stateFile(proxy, 'dsh-reports-outbox.json')).map((entry) => entry.report)];
}

/** dsh's model service: `stream()` yields the chunks a DeepSeek Messages adapter does for one text answer. */
export function fakeLlm(answer = GENE) {
  const calls = [];
  return {
    calls,
    answer,
    async *stream(options) {
      calls.push(options);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: this.answer };
      yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 120, totalTokens: 1020 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

function rejectInvalidCommand(definition) {
  const { name, description, input, handler } = definition;
  if (!COMMAND_NAME.test(name)) throw new TypeError(`command name "${name}" must match ${String(COMMAND_NAME)}`);
  if (typeof description !== 'string' || description.trim().length === 0) throw new TypeError(`command "${name}" description must not be empty`);
  if (typeof handler !== 'function') throw new TypeError(`command "${name}" handler must be a function`);
  if (input !== undefined && (typeof input?.hint !== 'string' || input.hint.trim().length === 0)) throw new TypeError(`command "${name}" input hint must not be empty`);
  return definition;
}

const runtimeContext = () => DSH.preStep.prompt.messages.find((message) => message.source.kind === 'runtime-context');
const userMessage = (text) => ({ ...DSH.preStep.prompt.messages[0], id: `msg-${Math.random().toString(16).slice(2)}`, content: [{ type: 'text', text }] });

export async function startDsh({ config = {}, llm = fakeLlm() } = {}) {
  const plugin = await loadPlugin();
  const listeners = new Map();
  const disposers = [];
  const commands = [];
  const tools = [];
  const ctx = {
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return () => listeners.set(event, listeners.get(event).filter((known) => known !== listener));
    },
    inject: (deps, callback) => callback({ llm, commands: { register: (definition) => commands.push(rejectInvalidCommand(definition)) }, tools: { register: (definition) => tools.push(definition) } }),
    effect: (execute) => disposers.push(execute()),
    tools: { register: (definition) => tools.push(definition) },
  };
  plugin.apply(ctx, validatedConfig(plugin, config));

  const listenersOf = (event) => listeners.get(event) ?? [];
  const emit = (event, ...args) => listenersOf(event).forEach((listener) => listener(...args));
  const waterfall = (event, payload, last) => listenersOf(event).reduceRight((next, listener) => () => listener(payload, next), last)();

  const dsh = {
    plugin,
    ctx,
    llm,
    listeners,
    commands,
    tools,
    async createAgent({ sessionId = `session-${Math.random().toString(16).slice(2)}`, cwd = projectDirectory(), source = 'startup', header = {} } = {}) {
      const agent = {
        id: sessionId,
        options: { provider: 'deepseek-official', model: 'deepseek-flash' },
        session: { id: sessionId, header: { version: 4, id: sessionId, createdAt: Date.now(), cwd, isSeeded: false, ...header } },
        injected: [],
        followups: [],
        inject(message) { this.injected.push(message); },
        followup(message) { this.followups.push(message); },
      };
      for (const listener of listenersOf('agent/created')) await listener({ agent, source, signal: new AbortController().signal });
      return agent;
    },
    preStep(agent, { turn, step, messages }) {
      return waterfall('agent/pre-step', { agent, turn, step, messages, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }));
    },
    tool(agent, { name, arguments: args, result, callId = `toolu_${Math.random().toString(16).slice(2)}` }) {
      return waterfall('tools/execute', { agent, name, arguments: args, callId, rootCallId: callId, signal: new AbortController().signal }, async () => result);
    },
    event(agent, type, data) {
      emit('session/event', agent.session, { type, data });
    },
    dispose: async () => Promise.all(disposers.map((dispose) => dispose?.())),
    /** Resolves once every host event raised so far for the agent's session was handled: they are handled in order. */
    settled: (agent) => dsh.tool(agent, { name: 'todo_write', arguments: { todos: [] }, result: { isError: false, content: [] } }),
    disposeSession(agent) {
      emit('session/disposed', agent.session);
    },
    command(agent, name, rawInput = '') {
      const command = commands.find((candidate) => candidate.name === name);
      assert.ok(command, `/${name} is registered`);
      return command.handler({ commandId: 'cmd-1', agent, rawInput, attachments: [], signal: new AbortController().signal });
    },

    /** One turn the way dsh's loop runs it: a step per tool call, then the answer, then `turn/end`. */
    async turn(agent, { turn = 1, prompt = PROMPT, tools: calls = [], answer = 'Done.', reason = { kind: 'completed' }, firstMessages } = {}) {
      const opened = await dsh.preStep(agent, { turn, step: 1, messages: firstMessages ?? [userMessage(prompt), runtimeContext()] });
      const steps = [opened];
      for (const [index, call] of calls.entries()) {
        if (index > 0) steps.push(await dsh.preStep(agent, { turn, step: index + 1, messages: [] }));
        dsh.event(agent, 'assistant/message', { ...DSH.assistantMessage.toolCall, turn, step: index + 1 });
        await dsh.tool(agent, call);
      }
      if (calls.length > 0) steps.push(await dsh.preStep(agent, { turn, step: calls.length + 1, messages: [] }));
      if (answer) dsh.event(agent, 'assistant/message', { ...DSH.assistantMessage.answer, turn, step: Math.max(1, calls.length + 1), message: { ...DSH.assistantMessage.answer.message, content: [{ type: 'text', text: answer }] } });
      dsh.event(agent, 'turn/end', { turn, reason });
      return steps;
    },
  };
  return dsh;
}

const bashResult = (template, { exitCode = 0, text }) => ({
  ...template.result,
  content: [{ type: 'text', text }],
  value: { ...template.result.value, exitCode, stdout: { text, truncated: false } },
});

export const bash = (command, { exitCode = 0, text = '' } = {}) => ({ name: 'bash', arguments: { command, description: 'Run it' }, result: bashResult(DSH.tools.bashPassed, { exitCode, text }) });

export const write = (filePath, content = 'export const options = { maxRetriesPerRequest: null };\n') => ({
  name: 'write',
  arguments: { file_path: filePath, content },
  result: { ...DSH.tools.write.result, value: { ...DSH.tools.write.result.value, path: filePath, after: content } },
});

/** A turn that wrote a file and ended on a passing check: the kind that becomes the session's candidate. */
export const verifiedTurn = (dsh, agent, options = {}) => dsh.turn(agent, {
  tools: [write('lib/redis.js'), bash('npm test 2>&1 | tail -5', { text: 'ℹ pass 4\nℹ fail 0' })],
  answer: 'Set maxRetriesPerRequest to null; the suite passes.',
  ...options,
});
