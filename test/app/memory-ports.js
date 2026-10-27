// In-memory ports: the use cases run against these without a filesystem, a process or a network.

export const ASSET = {
  asset_id: 'sha256:' + 'a'.repeat(64),
  short_title: 'Fix flaky Redis connection retries',
  summary: 'Stabilise redis connection retries in tests',
  signals_match: ['redis', 'connection', 'retries', 'flaky'],
  strategy: [
    'Set `maxRetriesPerRequest` to null in lib/redis.js',
    'Run npm test to confirm the suite passes',
    'Wrap the client in a singleton factory module',
    'Close the connection in the global teardown hook',
  ],
};

export const PROMPT = 'fix the flaky redis connection retries in our tests';

const table = (empty) => {
  let value = structuredClone(empty);
  return {
    read: async () => structuredClone(value),
    update: async (mutate) => {
      const next = mutate(structuredClone(value));
      if (next !== undefined) value = next;
      return next;
    },
  };
};

const lines = () => {
  const byKey = new Map();
  return {
    append: async (key, line) => byKey.set(key, [...(byKey.get(key) ?? []), line]),
    take: async (key) => {
      const taken = byKey.get(key) ?? [];
      byKey.delete(key);
      return { lines: taken, commit: async () => {} };
    },
    clear: async (key) => byKey.delete(key),
  };
};

export function memoryPorts({ assets = [ASSET], distillAnswer = null, model = null, owner = 4242, gone = new Set(), now = 1_000_000 } = {}) {
  const sessions = new Map();
  const notes = lines();
  const edits = lines();
  const requests = [];
  const queued = [];
  const scheduled = [];
  const retained = [];
  let time = now;
  const ports = {
    identity: { agent: 'testagent', label: 'Test Agent' },
    sessions: {
      read: async (id) => structuredClone(sessions.get(id) ?? {}),
      update: async (id, mutate) => {
        const next = mutate(structuredClone(sessions.get(id) ?? {}));
        if (next !== undefined) sessions.set(id, { ...next, sessionId: id });
        return next;
      },
      updateEach: async (mutate) => {
        for (const [id, stored] of sessions) {
          const next = mutate(structuredClone(stored), id);
          if (next !== undefined) sessions.set(id, { ...next, sessionId: id });
        }
      },
    },
    notes: {
      append: (id, note) => notes.append(id, note),
      take: async (id) => {
        const { lines: taken, commit } = await notes.take(id);
        return { notes: taken, commit };
      },
      clear: (id) => notes.clear(id),
    },
    baseline: {
      remember: (id, file, turnId = null) => edits.append(id, { file, before: `hash-of-${file}`, turnId }),
      take: async (id, turnId = null) => {
        const { lines: taken, commit } = await edits.take(id);
        const ofTurn = (line) => !line.turnId || !turnId || line.turnId === turnId;
        return { before: new Map(taken.filter(ofTurn).map(({ file, before }) => [file, before])), commit };
      },
    },
    candidates: table({}),
    drafts: table([]),
    reports: { enqueue: async (entries) => queued.push(...entries) },
    outbox: { drain: async () => true },
    retention: {
      remember: async (entry) => retained.push(entry),
      takeDue: async () => ({ due: [], commit: async () => {} }),
    },
    proxy: {
      request: async (method, path, body) => {
        requests.push({ method, path, body });
        if (path === '/asset/fetch') return { ok: true, data: { assets } };
        if (path === '/conversation/distill') return { ok: true, data: distillAnswer };
        return { ok: true, data: { recorded: true } };
      },
    },
    model,
    owner: { current: () => owner, self: () => 7, isGone: (pid) => gone.has(pid) },
    scheduler: { schedule: (tasks) => scheduled.push(...tasks) },
    clock: { now: () => time, sleep: async (ms) => { await new Promise((resolve) => setImmediate(resolve)); time += ms; } },
    engine: { needsSetup: async () => false, setUp: async () => {}, retryNow: async () => {}, outcome: async () => null, takeUnannounced: async () => null },
    ledger: { record: async () => true },
    cli: { run: async (args, { cwd } = {}) => ({ ok: true, text: `ran ${args.join(' ')}${cwd ? ` in ${cwd}` : ''}` }) },
    signIn: { latest: async () => null, joinOrStart: async () => null, forget: async () => {} },
  };
  return { ports, requests, queued, scheduled, retained, sessions, advance: (ms) => { time += ms; } };
}
