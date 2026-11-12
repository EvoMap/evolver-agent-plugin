import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { pack } from '../../../scripts/pack.mjs';
import { fileStoresOf } from '../../../lib/runtime/store/file-stores.js';
import { fakeProxy } from '../../helpers/fake-proxy.js';
import { useProcessHome } from '../../helpers/process-home.js';
import { PROMPT, RECIPE, RECIPE_STEPS } from '../../app/memory-ports.js';
import { IR } from '../../app/work-turns.js';

export { PROMPT };

const packedRoot = mkdtempSync(join(tmpdir(), 'evolver-step-packed-'));
const packed = join(packedRoot, 'packed');
const ledgerCore = fileURLToPath(new URL('../../../node_modules/@evomap/evolver-core', import.meta.url));
after(() => rmSync(packedRoot, { recursive: true, force: true }));
let loaded;

// Reuse the immutable package; each extension instance still owns a fresh profile and channel.
async function packedPlugin() {
  if (!loaded) {
    pack('stepcode', packed);
    const manifest = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8'));
    const [entry] = manifest.pi.extensions;
    loaded = {
      extension: await import(pathToFileURL(join(packed, entry)).href),
      profile: (await import(pathToFileURL(join(packed, 'hosts/stepcode/profile.js')).href)).default,
    };
  }
  return loaded;
}

/** The Step 0.1.7 extension interface around the packed entry; the channel and stores are real. */
export async function stepHost(t, { env: envPatch = {}, ...options } = {}) {
  const proxy = await fakeProxy({ recipes: [RECIPE], stepAssets: RECIPE_STEPS, ...options });
  const home = useProcessHome(proxy.env.HOME);
  const agentDir = join(proxy.env.HOME, 'agent');
  const cwd = join(proxy.env.HOME, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const env = { ...home.env, STEP_CODING_AGENT_DIR: agentDir,
    EVOMAP_PROXY_PORT: proxy.env.EVOMAP_PROXY_PORT, EVOLVER_RECALL: 'on', EVOLVER_AUTO_DISTILL: 'off', EVOLVER_HEADLESS: '', ...envPatch };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  const handlers = new Map(), commands = new Map(), persisted = [], triggered = [], notices = [];
  const completion = { calls: [], answer: JSON.stringify(IR) };
  const provider = { id: 'fixture', streamSimple(model, context, options) {
    completion.calls.push({ model, context, options });
    return { result: async () => ({ role: 'assistant', provider: 'fixture', model: 'fixture-model', api: 'openai-responses',
      stopReason: 'stop', content: [{ type: 'text', text: completion.answer }], usage: { input: 12, output: 3 } }) };
  } };
  const auth = { ok: true, apiKey: 'private-fixture-key', headers: { 'X-Account': 'private-account' } };
  let active = false, controller = new AbortController(), closed = false;
  const ctx = {
    cwd, hasUI: false,
    model: { id: 'fixture-model', provider: 'fixture', api: 'openai-responses', baseUrl: 'https://fixture.example/v1' },
    thinkingLevel: 'off',
    modelRegistry: {
      getProvider: () => provider,
      getApiKeyAndHeaders: async () => auth,
      complete: () => { throw new Error('The mutable registry must not run a private completion'); },
    },
    get signal() { return active ? controller.signal : undefined; },
    isIdle: () => !active,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => 'native-step-session', getLeafId: () => 'native-message', getBranch: () => [] },
    ui: { notify: (text, kind) => notices.push({ text, kind }) },
  };
  const pi = {
    on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: (name, command) => commands.set(name, command),
    sendMessage: message => persisted.push(message),
    sendUserMessage: (content, options) => triggered.push({ content, options }),
    appendEntry: (...entry) => persisted.push(entry),
    getThinkingLevel: () => 'off',
  };
  const emit = async (name, payload = {}) => {
    if (name === 'before_agent_start') controller = new AbortController();
    if (name === 'agent_start') active = true;
    if (name === 'agent_settled' || name === 'session_shutdown') active = false;
    let event = { type: name, ...payload };
    for (const handler of handlers.get(name) ?? []) {
      const returned = await handler(event, ctx);
      if (returned) event = { ...event, ...returned };
    }
    return event;
  };
  t.after(async () => {
    try {
      if (!closed) { closed = true; await emit('session_shutdown'); }
    } finally {
      for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      home.restore();
      proxy.close();
    }
  });
  const { extension, profile } = await packedPlugin();
  const stores = fileStoresOf({ dir: profile.stateDir(env), agent: profile.name });
  // Like an installed engine, provide Core beside the CLI instead of probing the machine's global npm.
  const engineModules = join(stores.folder('engine'), 'node_modules', '@evomap');
  mkdirSync(engineModules, { recursive: true });
  symlinkSync(ledgerCore, join(engineModules, 'evolver-core'), process.platform === 'win32' ? 'junction' : 'dir');
  await extension.default(pi);
  return {
    proxy, ctx, api: pi, commands, handlers, persisted, triggered, notices, emit, stores, completion, provider, auth,
    abort: () => controller.abort(),
    shutdown: async () => { closed = true; return emit('session_shutdown'); },
    reload: async () => {
      if (!closed) await emit('session_shutdown');
      closed = false;
      handlers.clear(); commands.clear();
      await extension.default(pi);
    },
  };
}

export const requestsTo = (host, path) => host.proxy.requests.filter(request => request.path === path);

export async function until(condition, what) {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
