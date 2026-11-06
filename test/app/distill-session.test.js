import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runBackgroundTasks } from '../../lib/app/background.js';
import { distillText } from '../../lib/app/commands/distill.js';
import { runCommand } from '../../lib/app/commands/index.js';
import { MIN_WAKE_DELAY_MS, armDistillWakeUp, distillDue, distillSession, postAgentGene } from '../../lib/app/distill-session.js';
import { adoptStrategy, promptSubmitted } from '../../lib/app/prompt.js';
import { sessionEnded } from '../../lib/app/session-end.js';
import { toolFinished } from '../../lib/app/tool-result.js';
import { TASKS } from '../../lib/app/ports.js';
import { turnEnded } from '../../lib/app/turn-end.js';
import { IDLE_DISTILL_MS, RETRY_BASE_MS, UNDISTILLED_LEFTOVER_TTL_MS, nextDueAt } from '../../lib/distill/candidate.js';
import { memoryPorts } from './memory-ports.js';

const GENE = { title: 'Stabilise Redis retries', summary: 'Flaky Redis-backed tests stop failing once retries are unbounded and the client is shared.', strategy: ['Set maxRetriesPerRequest to null', 'Share one client', 'Close it in teardown'] };
const DRAFTED = {
  ok: true, status: 'draft', publishable: false, distill_id: 'd'.repeat(16), quality: { ok: true, score: 6, threshold: 5 }, signals: ['redis'],
  gene: { type: 'Gene', asset_id: 'sha256:' + 'g'.repeat(64), summary: GENE.summary },
  capsule: { type: 'Capsule', asset_id: 'sha256:' + 'c'.repeat(64), summary: GENE.summary },
};

const PROJECT = { root: '/proj', head: 'f'.repeat(40), diff: 'diff --git a/lib/redis.js b/lib/redis.js\n' };

const modelAnswering = (answer, onCall = () => {}) => ({
  complete: async () => {
    await onCall();
    return { answer: JSON.stringify(answer), usage: { inputTokens: 10, outputTokens: 5 } };
  },
});

async function withCandidate(options = {}) {
  const made = memoryPorts({ distillAnswer: DRAFTED, project: PROJECT, ...options });
  await verifiedTurn(made.ports, 's1');
  return made;
}

async function verifiedTurn(ports, sessionId, prompt = 'fix the flaky redis retries') {
  await promptSubmitted(ports, { sessionId, prompt, waitMs: 1_000 });
  await toolFinished(ports, { sessionId, note: { kind: 'edit', paths: ['/proj/lib/redis.js'] } });
  await toolFinished(ports, { sessionId, note: { kind: 'shell', command: 'npm test', exit: 0, output: 'ok' } });
  await turnEnded(ports, { sessionId, reason: 'answer', answer: 'Fixed the retries.', model: 'model-x', projectDir: '/proj' });
}

test('a session-end distillation the Proxy answers as a draft is kept as a draft and settles the candidate', async () => {
  const { ports, requests } = await withCandidate({ model: modelAnswering(GENE) });
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  const [outcome] = await distillDue(ports);
  assert.equal(outcome.status, 'drafted');
  assert.equal((await ports.candidates.read()).s1, undefined);
  assert.equal((await ports.drafts.read())[0].title, GENE.title);
  const { body } = requests.find((request) => request.path === '/conversation/distill');
  assert.deepEqual([body.platform, body.trigger, body.session_id, body.persist, body.publish], ['testagent', 'session_end', 'testagent:s1', true, false]);
  assert.deepEqual(body.execution, { trace: [{ command: 'npm test', exit: 0, source: 'observed' }] });
  assert.deepEqual(body.project, PROJECT);
  assert.deepEqual(body.distill_usage, { inputTokens: 10, outputTokens: 5 });
});

test('distillation omits a legacy snapshot with a credential before posting to the Proxy', async () => {
  const { ports, requests } = await withCandidate({ model: modelAnswering(GENE) });
  const diff = 'diff --git a/settings.json b/settings.json\n+{"accessToken":"opaque-example-123456789"}\n';
  await ports.candidates.update((pending) => ({ ...pending, s1: { ...pending.s1, project: { ...PROJECT, diff } } }));

  const outcome = await distillSession(ports, { sessionId: 's1' });
  assert.equal(outcome.status, 'drafted');
  const { body } = requests.find((request) => request.path === '/conversation/distill');
  assert.deepEqual(body.project, { diff_omitted: 'secret' });
  assert.doesNotMatch(JSON.stringify(body), /opaque-example/);
});

test('a diff that would push the distillation past the Proxy\'s 256 KiB body limit is left out and marked truncated', async () => {
  const { ports, requests } = await withCandidate({ model: modelAnswering(GENE), project: { ...PROJECT, diff: 'x'.repeat(256 * 1024 - 100) } });
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  await distillDue(ports);
  const { body } = requests.find((request) => request.path === '/conversation/distill');
  assert.deepEqual(body.project, { diff_omitted: 'too_large' });
});

test('a live session\'s candidate is distilled once the session has been quiet long enough, with trigger idle', async () => {
  const { ports, requests, advance } = await withCandidate({ model: modelAnswering(GENE) });
  advance(IDLE_DISTILL_MS - 1);
  assert.deepEqual(await distillDue(ports), []);
  assert.ok((await ports.candidates.read()).s1);
  advance(1);
  assert.deepEqual((await distillDue(ports)).map((outcome) => outcome.status), ['drafted']);
  assert.equal(requests.find((request) => request.path === '/conversation/distill').body.trigger, 'idle');
});

test('a session still active keeps its candidate waiting; once it is quiet, a prompt in any session schedules the distillation', async () => {
  const { ports, scheduled, advance } = await withCandidate({ model: modelAnswering(GENE) });
  const distillsScheduled = () => scheduled.filter((task) => task === TASKS.DISTILL).length;
  advance(IDLE_DISTILL_MS - 1);
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'now explain the build', waitMs: 0 });
  advance(1);
  await promptSubmitted(ports, { sessionId: 's2', prompt: 'explain the build', waitMs: 0 });
  assert.equal(distillsScheduled(), 0);
  advance(IDLE_DISTILL_MS);
  await promptSubmitted(ports, { sessionId: 's2', prompt: 'explain the tests', waitMs: 0 });
  assert.equal(distillsScheduled(), 1);
});

test('an explicit distillation cannot duplicate its process\'s running background distillation', async () => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let completions = 0;
  const { ports, requests } = await withCandidate({ model: modelAnswering(GENE, async () => {
    completions += 1;
    started.resolve();
    await finish.promise;
  }) });
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  const background = distillDue(ports);
  await started.promise;
  const explicit = distillSession(ports, { sessionId: 's1' });
  await new Promise(setImmediate);
  finish.resolve();
  const [outcomes, answer] = await Promise.all([background, explicit]);
  assert.equal(completions, 1);
  assert.equal(requests.filter(({ path }) => path === '/conversation/distill').length, 1);
  assert.equal(outcomes[0].status, 'drafted');
  assert.equal(answer.status, 'busy');
  assert.equal((await ports.drafts.read()).length, 1);
});

test('with no model outside the conversation, a leftover waits a day for an agent\'s Gene, then is dropped', async () => {
  const { ports } = await withCandidate();
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  await runBackgroundTasks(ports, [TASKS.DISTILL]);
  assert.ok((await ports.candidates.read()).s1);
  await ports.clock.sleep(UNDISTILLED_LEFTOVER_TTL_MS + 1);
  await runBackgroundTasks(ports, [TASKS.DISTILL]);
  assert.equal((await ports.candidates.read()).s1, undefined);
});

test('a person who turned distillation off keeps the leftover from the background, and still distills it on demand', async () => {
  const { ports } = await withCandidate({ model: modelAnswering(GENE) });
  ports.settings = { recall: true, autoDistill: false };
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  await runBackgroundTasks(ports, [TASKS.DISTILL]);
  assert.ok((await ports.candidates.read()).s1);
  assert.equal((await distillSession(ports, { sessionId: 's1' })).status, 'drafted');
});

test('a process shutting down stops a leftover\'s model call without counting a try, and gives the claim back', async () => {
  const stopping = new AbortController();
  const waitsForever = { complete: (model, prompt, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))) };
  const { ports } = await withCandidate({ model: waitsForever });
  ports.scheduler = { ...ports.scheduler, signal: stopping.signal };
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  const running = distillDue(ports);
  await new Promise((resolve) => setImmediate(resolve));
  stopping.abort();
  assert.deepEqual((await running).map((outcome) => outcome.status), ['stopped']);
  const { s1 } = await ports.candidates.read();
  assert.deepEqual([s1.attempts, s1.claimedBy ?? null], [0, null]);
});

test('the model may decline, which settles the candidate without calling the Proxy', async () => {
  const { ports, requests } = await withCandidate({ model: modelAnswering({ skip: 'routine edit' }) });
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  const [outcome] = await distillDue(ports);
  assert.deepEqual([outcome.status, outcome.reason], ['declined', 'routine edit']);
  assert.equal(requests.some((request) => request.path === '/conversation/distill'), false);
  assert.equal((await ports.candidates.read()).s1, undefined);
});

test('a candidate dropped by a correction while the model answers is not posted', async () => {
  const made = await withCandidate();
  const { ports, requests } = made;
  ports.model = modelAnswering(GENE, () => ports.candidates.update(({ s1, ...rest }) => rest));
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  const [outcome] = await distillDue(ports);
  assert.equal(outcome.status, 'dropped');
  assert.equal(requests.some((request) => request.path === '/conversation/distill'), false);
});

test('a correction while a draft request is pending discards its late reply', async () => {
  const { ports } = await withCandidate({ model: modelAnswering(GENE) });
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const request = ports.proxy.request;
  ports.proxy.request = async (...args) => {
    const reply = await request(...args);
    if (args[1] === '/conversation/distill') {
      started.resolve();
      await finish.promise;
    }
    return reply;
  };
  const running = distillSession(ports, { sessionId: 's1' });
  await started.promise;
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'still failing', waitMs: 0 });
  finish.resolve();
  const outcome = await running;
  assert.equal(outcome.status, 'dropped');
  assert.equal(distillText(outcome).text, 'A newer turn replaced the one this Gene was written for.');
  assert.deepEqual(await ports.drafts.read(), []);
  assert.equal((await ports.candidates.read()).s1, undefined);
});

test('a correction while a request is pending still reports a Gene the Proxy stored', async () => {
  const stored = { status: 'stored', gene: DRAFTED.gene };
  const { ports, requests } = await withCandidate({ model: modelAnswering(GENE), distillAnswer: stored });
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const request = ports.proxy.request;
  ports.proxy.request = async (...args) => {
    const reply = await request(...args);
    if (args[1] === '/conversation/distill') {
      started.resolve();
      await finish.promise;
    }
    return reply;
  };

  const running = runCommand(ports, { sessionId: 's1', name: 'evolver-distill' });
  await started.promise;
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'still failing', waitMs: 0 });
  finish.resolve();
  const answer = await running;
  assert.equal(answer.ok, true);
  assert.deepEqual(JSON.parse(answer.text), stored);
  assert.equal(requests.filter(({ path }) => path === '/conversation/distill').length, 1);
  assert.deepEqual(await ports.drafts.read(), []);
  assert.equal((await ports.candidates.read()).s1, undefined);
});

test('a correction while an agent Gene request is pending discards its late draft', async () => {
  const { ports } = await withCandidate();
  const writtenFor = ports.candidates.referenceOf('s1', (await ports.candidates.read()).s1);
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const request = ports.proxy.request;
  ports.proxy.request = async (...args) => {
    const reply = await request(...args);
    if (args[1] === '/conversation/distill') {
      started.resolve();
      await finish.promise;
    }
    return reply;
  };
  const running = postAgentGene(ports, { sessionId: 's1', text: JSON.stringify(GENE), writtenFor });
  await started.promise;
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'still failing', waitMs: 0 });
  finish.resolve();
  assert.equal((await running).status, 'dropped');
  assert.deepEqual(await ports.drafts.read(), []);
  assert.equal((await ports.candidates.read()).s1, undefined);
});

test('a corrected request reaching the draft store late preserves a newer draft with the same ID', async () => {
  const { ports } = await withCandidate({ model: modelAnswering(GENE) });
  const earlier = (await ports.candidates.read()).s1;
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const update = ports.drafts.update;
  let pauseFirst = true;
  ports.drafts.update = async (mutate) => {
    if (pauseFirst) {
      pauseFirst = false;
      started.resolve();
      await finish.promise;
    }
    return update(mutate);
  };

  const late = distillSession(ports, { sessionId: 's1' });
  await started.promise;
  let newer;
  try {
    await verifiedTurn(ports, 's1', 'still failing');
    ports.model = modelAnswering({ ...GENE, title: 'Newer verified retries' });
    newer = await distillSession(ports, { sessionId: 's1' });
    assert.equal(newer.status, 'drafted');
    assert.equal(newer.draft.id, DRAFTED.distill_id);
    assert.equal(newer.draft.sourceCandidate.at, earlier.at);
    assert.equal(newer.draft.sourceCandidate.turn, earlier.turn + 1);
    assert.deepEqual(await ports.drafts.read(), [newer.draft]);
  } finally {
    finish.resolve();
  }

  assert.equal((await late).status, 'dropped');
  assert.deepEqual(await ports.drafts.read(), [newer.draft]);
});

test('an older candidate from another session settles without replacing a newer same-ID draft', async () => {
  const { ports, advance } = await withCandidate({ model: modelAnswering(GENE) });
  advance(1);
  await verifiedTurn(ports, 's2');
  const newer = await distillSession(ports, { sessionId: 's2' });
  assert.equal(newer.status, 'drafted');

  const outcome = await distillSession(ports, { sessionId: 's1' });
  assert.equal(outcome.status, 'superseded');
  assert.match(distillText(outcome).text, /same ID is already saved/);
  assert.equal((await ports.candidates.read()).s1, undefined);
  assert.deepEqual(await ports.drafts.read(), [newer.draft]);
});

test('a correction after the final candidate snapshot removes only the corrected turn draft', async () => {
  const { ports } = await withCandidate({ model: modelAnswering(GENE) });
  const candidate = (await ports.candidates.read()).s1;
  const kept = [
    { id: 'earlier', sessionId: 's1', sourceCandidate: { at: candidate.at - 1, turn: candidate.turn - 1 } },
    { id: 'other-session', sessionId: 's2', sourceCandidate: { at: candidate.at, turn: candidate.turn } },
    { id: 'legacy', sessionId: 's1' },
  ];
  await ports.drafts.update(() => kept);
  const captured = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const read = ports.candidates.read;
  let paused = false;
  ports.candidates.read = async () => {
    const snapshot = await read();
    if (!paused && (await ports.drafts.read()).some(({ id }) => id === DRAFTED.distill_id)) {
      paused = true;
      captured.resolve();
      await resume.promise;
    }
    return snapshot;
  };

  const running = distillSession(ports, { sessionId: 's1' });
  await captured.promise;
  try {
    await promptSubmitted(ports, { sessionId: 's1', prompt: 'still failing', waitMs: 0 });
  } finally {
    resume.resolve();
  }
  const outcome = await running;
  assert.equal(outcome.status, 'draft_missing');
  assert.equal(distillText(outcome).ok, false);
  assert.match(distillText(outcome).text, /no longer available/);
  assert.equal((await ports.candidates.read()).s1, undefined);
  assert.deepEqual(await ports.drafts.read(), kept);
});

test('an agent Gene does not report a draft replaced with the same ID during settlement', async () => {
  const { ports } = await withCandidate();
  const writtenFor = ports.candidates.referenceOf('s1', (await ports.candidates.read()).s1);
  const update = ports.candidates.update;
  let replacement;
  ports.candidates.update = async (mutate) => {
    const next = await update(mutate);
    if (!replacement && next && !next.s1) {
      const [draft] = await ports.drafts.read();
      replacement = { ...draft, title: 'Draft from another session', sessionId: 's2' };
      await promptSubmitted(ports, { sessionId: 's1', prompt: 'still failing', waitMs: 0 });
      await ports.drafts.update(() => [replacement]);
    }
    return next;
  };

  const outcome = await postAgentGene(ports, { sessionId: 's1', text: JSON.stringify(GENE), writtenFor });
  assert.equal(outcome.status, 'draft_missing');
  assert.equal(distillText(outcome).ok, false);
  assert.equal(replacement.id, DRAFTED.distill_id);
  assert.deepEqual(await ports.drafts.read(), [replacement]);
});

test('a correction removes the saved draft even after its candidate has settled', async () => {
  const { ports } = await withCandidate({ model: modelAnswering(GENE) });
  const saved = await distillSession(ports, { sessionId: 's1' });
  assert.equal(saved.status, 'drafted');
  assert.equal((await ports.candidates.read()).s1, undefined);

  await promptSubmitted(ports, { sessionId: 's1', prompt: 'still failing', waitMs: 0 });
  assert.deepEqual(await ports.drafts.read(), []);
});

test('a correction after an older plugin version dropped the session epoch still removes and blocks that turn\'s draft', async () => {
  const { ports } = await withCandidate({ model: modelAnswering(GENE) });
  assert.equal((await distillSession(ports, { sessionId: 's1' })).status, 'drafted');
  const [draft] = await ports.drafts.read();
  assert.ok(draft.sourceCandidate.sessionEpoch !== undefined);
  await ports.sessions.update('s1', ({ sessionEpoch, ...older }) => older);

  await promptSubmitted(ports, { sessionId: 's1', prompt: 'still failing', waitMs: 0 });
  assert.deepEqual(await ports.drafts.read(), []);
  assert.equal(await ports.draftCorrections.has('s1', draft.sourceCandidate.turn, draft.sourceCandidate.sessionEpoch), true);
});

test('a session written before epochs existed corrects its drafts under no epoch', async () => {
  const { ports } = memoryPorts({ distillAnswer: DRAFTED, project: PROJECT, model: modelAnswering(GENE) });
  await ports.sessions.update('s1', () => ({ turn: 4 }));
  await verifiedTurn(ports, 's1');
  assert.equal((await distillSession(ports, { sessionId: 's1' })).status, 'drafted');
  const [draft] = await ports.drafts.read();
  assert.deepEqual([draft.sourceCandidate.turn, draft.sourceCandidate.sessionEpoch], [5, undefined]);

  await promptSubmitted(ports, { sessionId: 's1', prompt: 'still failing', waitMs: 0 });
  assert.deepEqual(await ports.drafts.read(), []);
  assert.equal(await ports.draftCorrections.has('s1', 5, undefined), true);
});

test('background distillation checks an idle draft again before returning the batch', async () => {
  const { ports, advance, requests } = await withCandidate();
  advance(1);
  await verifiedTurn(ports, 's2');
  await sessionEnded(ports, { sessionId: 's2', projectDir: '/proj' });
  advance(IDLE_DISTILL_MS - 1);
  let completions = 0;
  ports.model = modelAnswering(GENE, async () => {
    if (++completions === 2) await promptSubmitted(ports, { sessionId: 's1', prompt: 'still failing', waitMs: 0 });
  });

  const outcomes = await distillDue(ports);
  assert.deepEqual(requests.filter(({ path }) => path === '/conversation/distill').map(({ body }) => body.trigger), ['idle', 'session_end']);
  assert.deepEqual(outcomes.map(({ status }) => status), ['draft_missing', 'drafted']);
  assert.deepEqual(await ports.drafts.read(), [outcomes[1].draft]);
});

for (const [count, replace] of [[1, false], [25, false], [25, true]]) test(`a correction crossing a draft write keeps ${count} earlier drafts${replace ? ' and a concurrent same-id replacement' : ''}`, async () => {
  const { ports } = await withCandidate({ model: modelAnswering(GENE) });
  const kept = Array.from({ length: count }, (_, index) => ({ id: `earlier-${index}`, title: 'Keep this method', createdAt: ports.clock.now() }));
  await ports.drafts.update(() => kept);
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const update = ports.drafts.update;
  let firstWrite = true;
  ports.drafts.update = async (mutate) => {
    const written = await update(mutate);
    if (firstWrite) {
      firstWrite = false;
      started.resolve();
      await finish.promise;
    }
    return written;
  };
  const running = distillSession(ports, { sessionId: 's1' });
  await started.promise;
  let replacement;
  if (replace) await update((drafts) => drafts.map((draft) => {
    if (draft.id !== DRAFTED.distill_id) return draft;
    replacement = { ...draft, title: 'Concurrent method', sourceCandidate: { ...draft.sourceCandidate, turn: draft.sourceCandidate.turn + 1 } };
    return replacement;
  }));
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'still failing', waitMs: 0 });
  finish.resolve();
  assert.equal((await running).status, 'dropped');
  assert.deepEqual(await ports.drafts.read(), replace ? [...kept, replacement] : kept);
});

for (const other of ['legacy draft', 'same candidate', 'newer turn', 'other session', 'discarded draft']) {
  test(`draft compensation never restores a displaced draft and preserves concurrent replacements (${other})`, async () => {
    const { ports } = await withCandidate({ model: modelAnswering(GENE) });
    const candidate = (await ports.candidates.read()).s1;
    const previous = { id: DRAFTED.distill_id, title: 'Earlier method', createdAt: ports.clock.now(), sessionId: 's1' };
    if (other === 'same candidate') previous.sourceCandidate = { at: candidate.at, turn: candidate.turn, sessionEpoch: candidate.sessionEpoch };
    const replacement = { ...previous, title: 'Concurrent method', sourceCandidate: { at: candidate.at, turn: candidate.turn + 1 } };
    if (other === 'other session') Object.assign(replacement, { sessionId: 's2', sourceCandidate: { at: candidate.at, turn: candidate.turn } });
    const before = { ...previous, id: 'before', sourceCandidate: { at: candidate.at - 1, turn: candidate.turn - 1 } };
    const after = { ...previous, id: 'after', sessionId: 's2' };
    await ports.drafts.update(() => [before, previous, after]);
    const update = ports.drafts.update;
    let firstWrite = true;
    ports.drafts.update = async (mutate) => {
      const written = await update(mutate);
      if (firstWrite) {
        firstWrite = false;
        await promptSubmitted(ports, { sessionId: 's1', prompt: 'still failing', waitMs: 0 });
        if (other === 'newer turn' || other === 'other session') await update(() => [before, replacement, after]);
        if (other === 'discarded draft') await update(() => [before, after]);
      }
      return written;
    };
    assert.equal((await distillSession(ports, { sessionId: 's1' })).status, 'dropped');
    const expected = other === 'newer turn' || other === 'other session' ? [replacement] : [];
    assert.deepEqual(await ports.drafts.read(), [before, ...expected, after]);
  });
}

for (const entry of ['headless model', 'agent Gene']) {
  test(`a failed correction cleanup is reported for a draft from the ${entry}`, async (t) => {
    const { ports, requests } = await withCandidate({ model: modelAnswering(GENE) });
    const writtenFor = ports.candidates.referenceOf('s1', (await ports.candidates.read()).s1);
    const update = ports.drafts.update;
    let writes = 0;
    let signal;
    if (entry === 'headless model') {
      t.mock.timers.enable({ apis: ['setInterval'] });
      const request = ports.proxy.request;
      ports.proxy.request = (...args) => {
        if (args[1] === '/conversation/distill') signal = args[3].signal;
        return request(...args);
      };
    }
    ports.drafts.update = async (mutate) => {
      if (++writes > 1) throw Object.assign(new Error('fixture cleanup denied'), { code: 'EACCES' });
      const written = await update(mutate);
      await assert.rejects(promptSubmitted(ports, { sessionId: 's1', prompt: 'still failing', waitMs: 0 }), { code: 'EACCES' });
      if (signal) t.mock.timers.tick(1_000);
      return written;
    };

    const outcome = entry === 'headless model'
      ? await distillSession(ports, { sessionId: 's1' })
      : await postAgentGene(ports, { sessionId: 's1', text: JSON.stringify(GENE), writtenFor });
    if (entry === 'headless model') assert.equal(signal.aborted, true);
    assert.equal(writes, 3);
    assert.equal(requests.filter(({ path }) => path === '/conversation/distill').length, 1);
    assert.equal((await ports.candidates.read()).s1, undefined);
    assert.deepEqual((await ports.drafts.read()).map(({ id }) => id), [DRAFTED.distill_id]);
    assert.equal(outcome.status, 'cleanup_failed');
    assert.equal(distillText(outcome).ok, false);
    assert.match(distillText(outcome).text, /could not remove it/i);

    ports.drafts.update = update;
    await promptSubmitted(ports, { sessionId: 's1', prompt: 'still failing', waitMs: 0 });
    assert.deepEqual(await ports.drafts.read(), []);
  });
}

test('a superseded draft stays blocked when distillation cannot undo its write', async () => {
  const { ports, requests } = await withCandidate({
    model: modelAnswering(GENE),
    distillAnswer: { ...DRAFTED, publishable: true, publish_receipt: { receiptId: 'proxy-issued-receipt' } },
  });
  const updateDrafts = ports.drafts.update;
  ports.drafts.update = async (mutate) => {
    const written = await updateDrafts(mutate);
    await ports.candidates.update((pending) => ({ ...pending, s1: { ...pending.s1, turn: pending.s1.turn + 1 } }));
    ports.drafts.update = async () => { throw new Error('draft cleanup denied'); };
    return written;
  };
  assert.equal((await distillSession(ports, { sessionId: 's1' })).status, 'cleanup_failed');
  ports.drafts.update = updateDrafts;
  assert.equal((await ports.drafts.read()).length, 1);
  const result = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'publish 1' });
  assert.equal(result.ok, false);
  assert.match(result.text, /not confirmed by distillation/i);
  assert.equal(requests.some(({ path }) => path === '/asset/reverify' || path === '/asset/submit'), false);
});

test('distillation does not advertise a corrected draft that cleanup could not remove', async () => {
  const { ports } = await withCandidate({ model: modelAnswering(GENE) });
  const updateDrafts = ports.drafts.update;
  let writes = 0;
  ports.drafts.update = async (mutate) => {
    if (++writes === 2) {
      ports.drafts.update = async () => { throw new Error('draft cleanup denied'); };
      try {
        await assert.rejects(promptSubmitted(ports, { sessionId: 's1', prompt: 'still failing', waitMs: 0 }), /draft cleanup denied/);
      } finally {
        ports.drafts.update = updateDrafts;
      }
    }
    return updateDrafts(mutate);
  };

  const outcome = await distillSession(ports, { sessionId: 's1' });
  assert.equal((await ports.drafts.read()).length, 1);
  assert.equal(outcome.status, 'draft_missing');
  assert.equal(distillText(outcome).ok, false);
});

test('a failing headless model keeps the candidate, tries again only after a doubling wait, and three failed tries give it up', async () => {
  const { ports, advance } = await withCandidate({ model: { complete: async () => { throw new Error('Authentication required'); } } });
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  assert.equal((await distillDue(ports))[0].status, 'model_failed');
  advance(RETRY_BASE_MS - 1);
  assert.deepEqual(await distillDue(ports), [], 'the first retry waits its delay');
  advance(1);
  assert.equal((await distillDue(ports))[0].status, 'model_failed');
  advance(RETRY_BASE_MS);
  assert.deepEqual(await distillDue(ports), [], 'the second wait is twice as long');
  advance(RETRY_BASE_MS);
  assert.equal((await distillDue(ports))[0].status, 'model_failed');
  assert.equal((await ports.candidates.read()).s1, undefined);
});

test('the next wake-up is when the earliest candidate no live process holds comes due', () => {
  const NOW = 10 * IDLE_DISTILL_MS;
  const LIVE = 1;
  const DEAD = 2;
  const isGone = (pid) => pid === DEAD;
  const rows = [
    ['quiet once its session has been idle long enough', { s1: { at: NOW - 5_000, activeAt: NOW - 1_000, pid: LIVE } }, NOW - 1_000 + IDLE_DISTILL_MS],
    ['a retry later than the quiet deadline', { s1: { at: NOW - 1_000, pid: LIVE, retryAt: NOW + IDLE_DISTILL_MS } }, NOW + IDLE_DISTILL_MS],
    ['claimed by a live process, which settles it', { s1: { at: NOW - 1_000, pid: LIVE, claimedBy: LIVE } }, null],
    ['over and waiting out its retry', { s1: { at: NOW - 1_000, pid: DEAD, retryAt: NOW + RETRY_BASE_MS } }, NOW + RETRY_BASE_MS],
    ['the earliest of several', { later: { at: NOW - 1_000, pid: LIVE }, sooner: { at: NOW - 2_000, pid: LIVE } }, NOW - 2_000 + IDLE_DISTILL_MS],
    ['one due already, as due now', { due: { at: NOW - IDLE_DISTILL_MS, pid: LIVE }, later: { at: NOW - 1_000, pid: LIVE } }, NOW],
    ['no candidates', {}, null],
  ];
  for (const [name, pending, expected] of rows) assert.equal(nextDueAt(pending, { now: NOW, isGone }), expected, name);
});

test('a wake-up keeps a candidate\'s own time when it is still to come, and waits a minute for one already due', async () => {
  const { ports, wakeUps } = memoryPorts({ model: { complete: async () => ({ answer: '' }) } });
  const now = ports.clock.now();
  await ports.candidates.update(() => ({ soon: { at: now + 10_000 - IDLE_DISTILL_MS, pid: 1 } }));
  await armDistillWakeUp(ports);
  await ports.candidates.update(() => ({ due: { at: now - IDLE_DISTILL_MS, pid: 1 } }));
  await armDistillWakeUp(ports);
  assert.deepEqual(wakeUps.map(({ at }) => at), [now + 10_000, now + MIN_WAKE_DELAY_MS]);
});

test('with no headless model, distilling now hands the agent the prompt, and its Gene becomes a draft', async () => {
  const { ports } = await withCandidate({ distillAnswer: { ...DRAFTED, publishable: true, publish_receipt: { receiptId: 'proxy-issued-receipt' } } });
  const asked = await distillSession(ports, { sessionId: 's1' });
  assert.equal(asked.status, 'no_model');
  assert.match(asked.agentGene.prompt, /Turn it into one reusable Gene/);
  assert.ok((await ports.candidates.read()).s1);
  const posted = await postAgentGene(ports, { sessionId: 's1', text: JSON.stringify(GENE), writtenFor: asked.agentGene.writtenFor });
  assert.equal(posted.status, 'drafted');
  const listed = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts' });
  assert.match(listed.text, /Stabilise Redis retries/);
  const published = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'publish 1' });
  assert.match(published.text, /^Submitted "Stabilise Redis retries"/);
  assert.equal((await ports.drafts.read()).length, 0);
});

test('a draft write failure releases the claim so the same process can retry', async () => {
  const { ports } = await withCandidate();
  const asked = await distillSession(ports, { sessionId: 's1' });
  const submission = { sessionId: 's1', text: JSON.stringify(GENE), writtenFor: asked.agentGene.writtenFor };
  const updateDrafts = ports.drafts.update;
  ports.drafts.update = async () => { throw new Error('disk full'); };

  await assert.rejects(postAgentGene(ports, submission), /disk full/);
  ports.drafts.update = updateDrafts;

  assert.equal((await postAgentGene(ports, submission)).status, 'drafted');
  assert.equal((await ports.drafts.read()).length, 1);
  assert.equal((await ports.candidates.read()).s1, undefined);
});

test('a Gene written for a candidate since replaced is not sent', async () => {
  const { ports, requests } = await withCandidate();
  assert.equal((await postAgentGene(ports, { sessionId: 's1', text: JSON.stringify(GENE), writtenFor: 1 })).status, 'dropped');
  assert.equal(requests.some((request) => request.path === '/conversation/distill'), false);
});

test('a Gene from an older turn cannot post against a new candidate with the same timestamp', async () => {
  const { ports, requests } = await withCandidate();
  const earlier = (await ports.candidates.read()).s1;
  const oldRequest = await distillSession(ports, { sessionId: 's1' });
  await verifiedTurn(ports, 's1', 'still failing');
  const newer = (await ports.candidates.read()).s1;
  assert.equal(newer.at, earlier.at);
  assert.equal(newer.turn, earlier.turn + 1);

  const gene = { sessionId: 's1', text: JSON.stringify(GENE) };
  assert.equal((await postAgentGene(ports, { ...gene, writtenFor: oldRequest.agentGene.writtenFor })).status, 'dropped');
  assert.equal((await postAgentGene(ports, { ...gene, writtenFor: earlier.at })).status, 'dropped');
  assert.equal(requests.some(({ path }) => path === '/conversation/distill'), false);
  const fresh = await distillSession(ports, { sessionId: 's1' });
  assert.notEqual(fresh.agentGene.writtenFor, oldRequest.agentGene.writtenFor);
  assert.equal((await postAgentGene(ports, { ...gene, writtenFor: fresh.agentGene.writtenFor })).status, 'drafted');
});

test('a terminal Gene selects its session even when another candidate has the same timestamp and turn', async () => {
  const { ports, requests } = await withCandidate();
  await verifiedTurn(ports, 's2');
  const { s1, s2 } = await ports.candidates.read();
  assert.deepEqual([s1.at, s1.turn], [s2.at, s2.turn]);
  const { agentGene } = await distillSession(ports, { sessionId: 's2' });
  const gene = { text: JSON.stringify(GENE), writtenFor: agentGene.writtenFor };

  assert.equal((await postAgentGene(ports, { ...gene, sessionId: 's1' })).status, 'dropped');
  assert.equal((await postAgentGene(ports, { ...gene, sessionId: 'terminal', anySession: true })).status, 'drafted');
  assert.deepEqual(requests.filter(({ path }) => path === '/conversation/distill').map(({ body }) => body.session_id), ['testagent:s2']);
  assert.equal((await ports.candidates.read()).s1.turn, s1.turn);
});

test('every command answers from the plugin; evolve is the one prompt for the agent', async () => {
  const { ports } = memoryPorts();
  assert.equal((await runCommand(ports, { sessionId: 's1', name: 'evolver-sync', args: '--dry-run "two words"' })).text, 'ran sync --dry-run two words');
  assert.equal((await runCommand(ports, { sessionId: 's1', name: 'evolver-evolve' })).forAgent, true);
  assert.match((await runCommand(ports, { sessionId: 's1', name: 'evolver-status' })).text, /No distillation candidate in this session/);
  assert.equal((await runCommand(ports, { sessionId: 's1', name: 'evolver-nope' })).ok, false);
});

test('a plugin command runs the engine in the session\'s project directory', async () => {
  const { ports } = memoryPorts();
  assert.equal((await runCommand(ports, { sessionId: 's1', projectDir: '/proj', name: 'evolver-run', args: '--dry-run' })).text, 'ran run --dry-run in /proj');
});

test('a searched strategy is only offered; adopted during a turn it is that turn\'s, between turns the next one\'s', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'explain the build', waitMs: 1_000 });
  const searched = await runCommand(ports, { sessionId: 's1', name: 'evolver-search', args: 'flaky redis connection retries in tests' });
  assert.equal(Object.keys((await ports.sessions.read('s1')).injected).length, 0);
  await adoptStrategy(ports, { sessionId: 's1', strategy: searched.strategy });
  const { reports } = await turnEnded(ports, { sessionId: 's1', reason: 'answer', answer: 'ok', projectDir: '/p' });
  assert.deepEqual(reports.map((report) => report.task_id), ['testagent:s1:1']);
});

test('a command run can be stopped: its signal reaches the evolver CLI', async () => {
  const { ports } = memoryPorts();
  let seen = null;
  ports.cli = { run: async (args, { signal }) => { seen = signal; return { ok: true, text: 'ran' }; } };
  const controller = new AbortController();
  await runCommand(ports, { sessionId: 's1', name: 'evolver-run', args: '--loop', signal: controller.signal });
  assert.equal(seen, controller.signal);
});
