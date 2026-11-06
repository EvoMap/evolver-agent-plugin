import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runBackgroundTasks } from '../../lib/app/background.js';
import { distillText } from '../../lib/app/commands/distill.js';
import { runCommand } from '../../lib/app/commands/index.js';
import { MIN_WAKE_DELAY_MS, armDistillWakeUp, distillDue, distillSession, dropExpiredLeftovers, postAgentGene, scheduleDueDistillation } from '../../lib/app/distill-session.js';
import { adoptStrategy, promptSubmitted } from '../../lib/app/prompt.js';
import { sessionEnded } from '../../lib/app/session-end.js';
import { TASKS } from '../../lib/app/ports.js';
import { turnEnded } from '../../lib/app/turn-end.js';
import { BLOCKED_ROUTE_TTL_MS, EPISODE_QUIET_MS, IDLE_DISTILL_MS, RETRY_BASE_MS, UNDISTILLED_LEFTOVER_TTL_MS, nextDueAt } from '../../lib/distill/range.js';
import { memoryPorts } from './memory-ports.js';
import { DRAFTED, IR, changeTurn, fixTurn, modelAnswering, turnOf } from './work-turns.js';

const PROJECT = {
  root: '/proj',
  head: 'f'.repeat(40),
  diff: 'diff --git a/lib/redis.js b/lib/redis.js\n--- a/lib/redis.js\n+++ b/lib/redis.js\n@@ -1 +1 @@\n-export const options = {};\n+export const options = { maxRetriesPerRequest: null };\n',
};
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value));
const distills = (requests) => requests.filter((request) => request.path === '/conversation/distill');

async function fixedSession(options = {}) {
  const made = memoryPorts({ distillAnswer: DRAFTED, project: PROJECT, ...options });
  await fixTurn(made.ports, 's1');
  return made;
}

async function threeTurnSession(options = {}) {
  const made = memoryPorts({ distillAnswer: DRAFTED, project: PROJECT, ...options });
  for (const index of [1, 2, 3]) await changeTurn(made.ports, 's1', index);
  return made;
}

async function endedAndDistilled(made) {
  await sessionEnded(made.ports, { sessionId: 's1', projectDir: '/proj' });
  return distillDue(made.ports);
}

const correct = (ports, sessionId = 's1') => promptSubmitted(ports, { sessionId, prompt: 'still failing', waitMs: 0 });
const correctionsOf = async (ports, sessionId = 's1') => (await ports.candidates.read())[sessionId]?.turns.map(({ correction }) => correction ?? null);

/** Holds the Proxy's answer to the first distillation request until `finish()`, once `started` resolved. */
function pausedAtProxy(ports) {
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
  return { started: started.promise, finish: finish.resolve };
}

/** A model on the session's captured route, `model-x`, failing as the runtime does while that route is unavailable. */
const routedModel = (route) => ({
  capture: () => 'model-x',
  async complete(model) {
    route.calls = (route.calls ?? 0) + 1;
    assert.equal(model, 'model-x');
    if (!route.available) throw Object.assign(new Error('unavailable'), { code: 'MODEL_UNAVAILABLE', reason: 'route_changed' });
    return { answer: JSON.stringify(IR) };
  },
});

test('a session-end distillation posts each IR in the contract\'s shape, keeps the Proxy\'s draft and the record for calibration', async () => {
  const made = await fixedSession({ model: modelAnswering(IR) });
  const [outcome] = await endedAndDistilled(made);
  assert.equal(outcome.status, 'drafted');
  assert.equal((await made.ports.candidates.read()).s1, undefined);
  assert.equal((await made.ports.drafts.read())[0].title, IR.title);
  const [{ body }] = distills(made.requests);
  assert.deepEqual(Object.keys(body), ['platform', 'session_id', 'trigger', 'ir_version', 'ir', 'record', 'user_prompt', 'final_answer', 'execution', 'project', 'project_dir', 'persist', 'publish', 'distill_usage']);
  assert.deepEqual([body.platform, body.session_id, body.trigger, body.ir_version, body.persist, body.publish, body.project_dir], ['testagent', 'testagent:s1', 'session_end', 'session-gene-ir-v1', true, false, '/proj']);
  assert.deepEqual(body.ir, IR);
  assert.deepEqual(body.record.slice(0, 9), [
    { kind: 'turn', text: 'Turn 1' },
    { kind: 'prompt', text: 'fix the flaky redis retries' },
    { kind: 'check', text: 'npm test', exit: 1 },
    { kind: 'output', text: 'ℹ tests 3' }, { kind: 'output', text: 'ℹ pass 2' }, { kind: 'output', text: 'ℹ fail 1' },
    { kind: 'output', text: 'MaxRetriesPerRequestError: Reached the max retries per request limit' },
    { kind: 'edit', text: 'lib/redis.js' },
    { kind: 'check', text: 'npm test 2>&1 | tail -5' },
  ]);
  assert.deepEqual(body.record.slice(9).map(({ kind }) => kind), ['answer', 'diff', 'diff', 'diff', 'diff', 'diff', 'diff']);
  assert.deepEqual(body.execution.trace, [{ command: 'npm test', exit: 1, source: 'observed' }, { command: 'npm test 2>&1 | tail -5', ok: true, source: 'observed' }]);
  assert.deepEqual([body.user_prompt, body.final_answer, body.project, body.distill_usage], ['fix the flaky redis retries', 'Fixed the retries.', PROJECT, { inputTokens: 10, outputTokens: 5 }]);
  const [kept] = await made.ports.corpus.read();
  assert.deepEqual([kept.gate.passed, kept.kind, kept.record], [true, 'fix', body.record]);
});

test('the record holds every work turn in order: a failed check\'s redacted output tail, the correction, and a diff cut to fit a prompt', async () => {
  const output = [...Array.from({ length: 30 }, (_, index) => `line ${index}`), 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'].join('\n');
  const files = Array.from({ length: 40 }, (_, index) => `diff --git a/src/f${index}.js b/src/f${index}.js\n--- a/src/f${index}.js\n+++ b/src/f${index}.js\n@@ -0,0 +1,40 @@\n${'+export const value = 1;\n'.repeat(40)}`);
  const made = memoryPorts({ model: modelAnswering(IR), distillAnswer: DRAFTED, project: { ...PROJECT, diff: files.join('') } });
  await turnOf(made.ports, 's1', { steps: [['note', { kind: 'shell', command: 'npm test', exit: 1, output }]] });
  await turnOf(made.ports, 's1', { prompt: '还是报错', steps: [['edit', '/proj/lib/redis.js'], ['pass', 'npm test']] });
  await endedAndDistilled(made);
  const [{ body }] = distills(made.requests);
  const outputs = body.record.filter(({ kind }) => kind === 'output').map(({ text }) => text);
  assert.deepEqual([outputs.length, outputs[0], outputs.at(-1)], [20, 'line 11', 'Authorization: [redacted]']);
  assert.doesNotMatch(JSON.stringify(body), /abcdefghijklmnop/);
  assert.deepEqual(body.record[body.record.findIndex(({ text }) => text === 'Turn 2') - 1], { kind: 'correction', text: '还是报错' });
  const diffLines = body.record.filter(({ kind }) => kind === 'diff');
  assert.match(diffLines[0].text, /^Diff too long to show whole: 40 files, \+1600 -0\.$/);
  assert.ok(Buffer.byteLength(diffLines.map(({ text }) => text).join('\n')) <= 24 * 1024);
  assert.equal(body.project.diff, files.join(''));
  assert.ok(bytesOf(body) <= 256 * 1024);
});

test('the range\'s diff is taken from the commit its first work turn began on, so a commit made since stays in it', async () => {
  const made = memoryPorts({ heads: ['a'.repeat(40), 'b'.repeat(40)] });
  await changeTurn(made.ports, 's1', 1);
  await changeTurn(made.ports, 's1', 2);
  assert.deepEqual(made.snapshotBases, ['a'.repeat(40), 'a'.repeat(40)]);
});

test('a diff is left out as too large when it would push the request past the Proxy\'s 256 KiB, and as secret when a saved one holds a credential', async () => {
  const rows = [
    ['too large', 'x'.repeat(256 * 1024 - 100), 'too_large'],
    ['a credential the filter now catches', 'diff --git a/settings.json b/settings.json\n+{"accessToken":"opaque-example-123456789"}\n', 'secret'],
  ];
  for (const [name, diff, reason] of rows) {
    const made = await fixedSession({ model: modelAnswering(IR) });
    await made.ports.candidates.update((pending) => ({ ...pending, s1: { ...pending.s1, project: { ...PROJECT, diff } } }));
    await endedAndDistilled(made);
    const [{ body }] = distills(made.requests);
    assert.deepEqual(body.project, { diff_omitted: reason }, name);
    assert.doesNotMatch(JSON.stringify([body, await made.ports.corpus.read()]), /opaque-example/, name);
  }
});

test('the gate decides without a model call whether a session\'s work is distilled, and distilled turns never are again', async () => {
  const rows = [
    ['two work turns', async (ports) => { await changeTurn(ports, 's1', 1); await changeTurn(ports, 's1', 2); }, ['below_threshold'], 0],
    ['three work turns', async (ports) => { for (const index of [1, 2, 3]) await changeTurn(ports, 's1', index); }, ['drafted'], 1],
    ['one fixed error', (ports) => fixTurn(ports, 's1'), ['drafted'], 1],
    ['one fixed error, checked again over the whole file through tail', (ports) => turnOf(ports, 's1', { steps: [
      ['note', { kind: 'shell', command: 'python -m pytest testing/test_rewrite.py::TestIssue::test_number', exit: 1, output: 'E   TypeError: int\n1 failed in 0.21s' }],
      ['edit', '/proj/src/rewrite.py'],
      ['note', { kind: 'shell', command: 'python -m pytest testing/test_rewrite.py -q 2>&1 | tail -3', exit: 0, output: '115 passed, 1 skipped in 1.99s' }],
    ] }), ['drafted'], 1],
    ['an error left unfixed', (ports) => turnOf(ports, 's1', { steps: [['fail', 'npm test'], ['edit', '/proj/a.js'], ['fail', 'npm test']] }), ['below_threshold'], 0],
    ['only reading and answering', (ports) => turnOf(ports, 's1', { prompt: 'explain the retry policy', steps: [['run', 'cat lib/redis.js']] }), [], 0],
  ];
  for (const [name, work, statuses, modelCalls] of rows) {
    let calls = 0;
    const made = memoryPorts({ distillAnswer: DRAFTED, model: modelAnswering(IR, () => { calls += 1; }) });
    await work(made.ports);
    assert.deepEqual((await endedAndDistilled(made)).map(({ status }) => status), statuses, name);
    assert.equal(calls, modelCalls, name);
  }
  const made = await threeTurnSession({ model: modelAnswering(IR) });
  made.advance(IDLE_DISTILL_MS);
  assert.deepEqual((await distillDue(made.ports)).map(({ status }) => status), ['drafted']);
  await changeTurn(made.ports, 's1', 4);
  assert.deepEqual(await endedAndDistilled(made), [{ status: 'below_threshold', reason: 'too_little_work', detail: '1 of 3 work turns and no fixed error' }]);
});

test('a live session is distilled ten minutes after it fixed an error, thirty after other work, and below the threshold waits for more work', async () => {
  const fixed = await fixedSession({ model: modelAnswering(IR) });
  fixed.advance(EPISODE_QUIET_MS - 1);
  assert.deepEqual(await distillDue(fixed.ports), []);
  fixed.advance(1);
  assert.deepEqual((await distillDue(fixed.ports)).map(({ status }) => status), ['drafted']);
  assert.equal(distills(fixed.requests)[0].body.trigger, 'error_episode');

  const worked = await threeTurnSession({ model: modelAnswering(IR) });
  worked.advance(IDLE_DISTILL_MS - 1);
  assert.deepEqual(await distillDue(worked.ports), []);
  worked.advance(1);
  assert.deepEqual((await distillDue(worked.ports)).map(({ status }) => status), ['drafted']);
  assert.equal(distills(worked.requests)[0].body.trigger, 'idle');

  const small = memoryPorts({ model: modelAnswering(IR) });
  await changeTurn(small.ports, 's1');
  small.advance(IDLE_DISTILL_MS);
  assert.deepEqual((await distillDue(small.ports)).map(({ status }) => status), ['below_threshold']);
  small.advance(IDLE_DISTILL_MS);
  assert.deepEqual(await distillDue(small.ports), []);
  assert.equal((await small.ports.outcomes.read()).length, 1);
});

test('/evolver-status names the last distillation\'s outcome, with the Proxy\'s reason and the terms it refused', async () => {
  const refused = { ok: true, status: 'draft', quality: { ok: false, reason: 'too_project_specific', terms: ['invoiceTotal', 'BILLING_URL'] } };
  const rows = [
    ['a Proxy rejection', { model: modelAnswering(IR), distillAnswer: refused }, fixTurn, 'Last distillation: rejected by the Proxy (too_project_specific: invoiceTotal, BILLING_URL), just now.'],
    ['a model skip', { model: modelAnswering({ skip: 'routine edit' }) }, fixTurn, 'Last distillation: declined by the model (routine edit), just now.'],
    ['below the threshold', { model: modelAnswering(IR) }, changeTurn, 'Last distillation: below the threshold, no model call (1 of 3 work turns and no fixed error), just now.'],
  ];
  for (const [name, options, work, line] of rows) {
    const made = memoryPorts(options);
    await work(made.ports, 's1');
    await endedAndDistilled(made);
    const { text } = await runCommand(made.ports, { sessionId: 's1', name: 'evolver-status' });
    assert.ok(text.split('\n').includes(line), `${name}: ${text}`);
  }
});

test('the model\'s answer is read as fenced JSON, an array or one object; up to two IRs go out, one request each, and one that breaks the shape stays here', async () => {
  const second = { ...IR, title: 'Share one Redis client' };
  const tooLong = { ...IR, scope: { ...IR.scope, signals: [...IR.scope.signals.slice(0, 4), 's'.repeat(65)] } };
  const rows = [
    ['fenced', `Here it is:\n\`\`\`json\n${JSON.stringify(IR)}\n\`\`\``, [IR.title], 'drafted'],
    ['an array of three', JSON.stringify([IR, second, { ...IR, title: 'A third' }]), [IR.title, second.title], 'drafted'],
    ['a signal over 64 characters', JSON.stringify(tooLong), [], 'rejected'],
  ];
  for (const [name, answer, titles, status] of rows) {
    const made = await fixedSession({ model: modelAnswering(answer) });
    const [outcome] = await endedAndDistilled(made);
    assert.deepEqual(distills(made.requests).map(({ body }) => body.ir.title), titles, name);
    assert.deepEqual(distills(made.requests).map(({ body }) => Boolean(body.distill_usage)), titles.map((_, index) => index === 0), name);
    assert.equal(outcome.status, status, name);
  }
  const made = await fixedSession({ model: modelAnswering(tooLong) });
  await endedAndDistilled(made);
  assert.deepEqual((await made.ports.outcomes.read()).at(-1), { status: 'rejected', title: IR.title, by: 'plugin', reason: 'ir_invalid', field: 'ir.scope.signals', session: 'testagent:s1', trigger: 'session_end', at: made.ports.clock.now() });
});

test('work turns that join the range while the model answers stay for the next distillation', async () => {
  const made = await fixedSession();
  made.ports.model = modelAnswering(IR, () => changeTurn(made.ports, 's1', 2));
  made.advance(EPISODE_QUIET_MS);
  assert.deepEqual((await distillDue(made.ports)).map(({ status }) => status), ['drafted']);
  assert.deepEqual((await made.ports.candidates.read()).s1.turns.map(({ turn }) => turn), [2]);
});

test('a correction of a turn being distilled discards the answer, and the range waits with the correction for the next distillation', async () => {
  const rows = [
    ['while the model answers', (made) => { made.ports.model = modelAnswering(IR, () => correct(made.ports)); }, (ports) => distillDue(ports).then(([outcome]) => outcome), 0],
    ['while the Proxy answers the model\'s IR', (made) => {
      const paused = pausedAtProxy(made.ports);
      paused.started.then(() => correct(made.ports)).then(paused.finish);
    }, (ports) => distillSession(ports, { sessionId: 's1' }), 1],
    ['while the Proxy answers the agent\'s IR', (made) => {
      const paused = pausedAtProxy(made.ports);
      paused.started.then(() => correct(made.ports)).then(paused.finish);
    }, async (ports) => postAgentGene(ports, { sessionId: 's1', text: JSON.stringify(IR), writtenFor: ports.candidates.referenceOf('s1', (await ports.candidates.read()).s1) }), 1],
  ];
  for (const [name, arrange, distill, posts] of rows) {
    const made = await fixedSession({ model: modelAnswering(IR) });
    await sessionEnded(made.ports, { sessionId: 's1', projectDir: '/proj' });
    arrange(made);
    const outcome = await distill(made.ports);
    assert.equal(outcome.status, 'dropped', name);
    assert.deepEqual([distillText(outcome).ok, /work changed/.test(distillText(outcome).text)], [false, true], name);
    assert.equal(distills(made.requests).length, posts, name);
    assert.deepEqual(await made.ports.drafts.read(), [], name);
    const { s1 } = await made.ports.candidates.read();
    assert.deepEqual([await correctionsOf(made.ports), s1.claimedBy, s1.attempts], [['still failing'], null, 0], name);
  }
});

test('a Gene the Proxy stored stands when a correction lands while it answers, and the corrected turn waits for the next distillation', async () => {
  const stored = { status: 'stored', gene: DRAFTED.gene };
  const { ports, requests } = await fixedSession({ model: modelAnswering(IR), distillAnswer: stored });
  const paused = pausedAtProxy(ports);
  const running = runCommand(ports, { sessionId: 's1', name: 'evolver-distill' });
  await paused.started;
  await correct(ports);
  paused.finish();
  const answer = await running;
  assert.deepEqual([answer.ok, answer.text], [true, `Stored "${IR.title}".`]);
  assert.equal(distills(requests).length, 1);
  assert.deepEqual(await ports.drafts.read(), []);
  assert.deepEqual(await correctionsOf(ports), ['still failing']);
});

test('a draft from an older range never replaces a newer one with the same ID: superseded while current, dropped once corrected', async () => {
  for (const [name, corrected, status] of [['still current', false, 'superseded'], ['corrected meanwhile', true, 'dropped']]) {
    const { ports, advance } = await fixedSession({ model: modelAnswering(IR) });
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
    advance(1);
    await fixTurn(ports, 's2');
    const newer = await distillSession(ports, { sessionId: 's2' });
    if (corrected) await correct(ports);
    finish.resolve();
    const outcome = await late;
    assert.equal(outcome.status, status, name);
    assert.equal(newer.results[0].draft.id, DRAFTED.distill_id, name);
    assert.deepEqual(await ports.drafts.read(), [newer.results[0].draft], name);
    assert.equal(Boolean((await ports.candidates.read()).s1), corrected, name);
    if (!corrected) assert.match(distillText(outcome).text, /same ID is already saved/, name);
  }
});

test('a correction after the range\'s last check removes only the corrected turn\'s draft, which is not reported as made', async () => {
  const { ports } = await fixedSession({ model: modelAnswering(IR) });
  const range = (await ports.candidates.read()).s1;
  const turn = range.turns.at(-1).turn;
  const kept = [
    { id: 'earlier', sessionId: 's1', sourceCandidate: { at: range.at - 1, turn: turn - 1 } },
    { id: 'other-session', sessionId: 's2', sourceCandidate: { at: range.at, turn } },
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
    await correct(ports);
  } finally {
    resume.resolve();
  }
  const outcome = await running;
  assert.equal(outcome.status, 'draft_missing');
  assert.equal(distillText(outcome).ok, false);
  assert.match(distillText(outcome).text, /no longer available/);
  assert.deepEqual(await correctionsOf(ports), ['still failing']);
  assert.deepEqual(await ports.drafts.read(), kept);
});

test('an agent\'s IR does not report a draft replaced with the same ID during settlement', async () => {
  const { ports } = await fixedSession();
  const writtenFor = ports.candidates.referenceOf('s1', (await ports.candidates.read()).s1);
  const update = ports.candidates.update;
  let replacement;
  ports.candidates.update = async (mutate) => {
    const next = await update(mutate);
    if (!replacement && next && !next.s1) {
      const [draft] = await ports.drafts.read();
      replacement = { ...draft, title: 'Draft from another session', sessionId: 's2' };
      await correct(ports);
      await ports.drafts.update(() => [replacement]);
    }
    return next;
  };
  const outcome = await postAgentGene(ports, { sessionId: 's1', text: JSON.stringify(IR), writtenFor });
  assert.equal(outcome.status, 'draft_missing');
  assert.equal(distillText(outcome).ok, false);
  assert.equal(replacement.id, DRAFTED.distill_id);
  assert.deepEqual(await ports.drafts.read(), [replacement]);
});

test('a correction after its turn was distilled removes that turn\'s draft and marks it under the epoch the draft carries', async () => {
  const rows = [
    ['a session with an epoch', async () => {}, async () => {}, 1],
    ['an epoch an older plugin version dropped', async () => {}, (ports) => ports.sessions.update('s1', ({ sessionEpoch, ...older }) => older), 1],
    ['a session written before epochs existed', (ports) => ports.sessions.update('s1', () => ({ turn: 4 })), async () => {}, 5],
  ];
  for (const [name, before, after, turn] of rows) {
    const { ports } = memoryPorts({ distillAnswer: DRAFTED, project: PROJECT, model: modelAnswering(IR) });
    await before(ports);
    await fixTurn(ports, 's1');
    assert.equal((await distillSession(ports, { sessionId: 's1' })).status, 'drafted', name);
    const [{ sourceCandidate }] = await ports.drafts.read();
    assert.deepEqual([sourceCandidate.turn, sourceCandidate.sessionEpoch === undefined], [turn, turn === 5], name);
    await after(ports);
    await correct(ports);
    assert.deepEqual(await ports.drafts.read(), [], name);
    assert.equal(await ports.draftCorrections.has('s1', turn, sourceCandidate.sessionEpoch), true, name);
  }
});

test('background distillation checks a draft again before returning the batch', async () => {
  const { ports, advance, requests } = await fixedSession();
  advance(1);
  await fixTurn(ports, 's2');
  await sessionEnded(ports, { sessionId: 's2', projectDir: '/proj' });
  advance(EPISODE_QUIET_MS - 1);
  let completions = 0;
  ports.model = modelAnswering(IR, async () => {
    if (++completions === 2) await correct(ports);
  });
  const outcomes = await distillDue(ports);
  assert.deepEqual(distills(requests).map(({ body }) => body.trigger), ['error_episode', 'session_end']);
  assert.deepEqual(outcomes.map(({ status }) => status), ['draft_missing', 'drafted']);
  assert.deepEqual(await ports.drafts.read(), [outcomes[1].results[0].draft]);
});

test('a correction crossing a draft write takes back only that draft: earlier drafts and a concurrent replacement stay', async () => {
  for (const [count, replace] of [[1, false], [25, false], [25, true]]) {
    const name = `${count} earlier drafts${replace ? ' and a concurrent same-ID replacement' : ''}`;
    const { ports } = await fixedSession({ model: modelAnswering(IR) });
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
    await correct(ports);
    finish.resolve();
    assert.equal((await running).status, 'dropped', name);
    assert.deepEqual(await ports.drafts.read(), replace ? [...kept, replacement] : kept, name);
  }
});

test('taking a corrected draft back never restores the draft it displaced, and keeps one that replaced it meanwhile', async () => {
  for (const other of ['legacy draft', 'same range', 'newer turn', 'other session', 'discarded draft']) {
    const { ports } = await fixedSession({ model: modelAnswering(IR) });
    const range = (await ports.candidates.read()).s1;
    const source = { at: range.at, turn: range.turns.at(-1).turn, sessionEpoch: range.sessionEpoch };
    const previous = { id: DRAFTED.distill_id, title: 'Earlier method', createdAt: ports.clock.now(), sessionId: 's1' };
    if (other === 'same range') previous.sourceCandidate = source;
    const replacement = { ...previous, title: 'Concurrent method', sourceCandidate: { at: source.at, turn: source.turn + 1 } };
    if (other === 'other session') Object.assign(replacement, { sessionId: 's2', sourceCandidate: { at: source.at, turn: source.turn } });
    const before = { ...previous, id: 'before', sourceCandidate: { at: source.at - 1, turn: source.turn - 1 } };
    const after = { ...previous, id: 'after', sessionId: 's2' };
    await ports.drafts.update(() => [before, previous, after]);
    const update = ports.drafts.update;
    let firstWrite = true;
    ports.drafts.update = async (mutate) => {
      const written = await update(mutate);
      if (firstWrite) {
        firstWrite = false;
        await correct(ports);
        if (other === 'newer turn' || other === 'other session') await update(() => [before, replacement, after]);
        if (other === 'discarded draft') await update(() => [before, after]);
      }
      return written;
    };
    assert.equal((await distillSession(ports, { sessionId: 's1' })).status, 'dropped', other);
    const expected = other === 'newer turn' || other === 'other session' ? [replacement] : [];
    assert.deepEqual(await ports.drafts.read(), [before, ...expected, after], other);
  }
});

test('a correction whose draft cleanup fails is reported, for a draft from the headless model or the agent, and cleaned up by the next', async (t) => {
  for (const entry of ['headless model', 'agent']) {
    const { ports, requests } = await fixedSession({ model: modelAnswering(IR) });
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
      await assert.rejects(correct(ports), { code: 'EACCES' });
      if (signal) t.mock.timers.tick(1_000);
      return written;
    };
    const outcome = entry === 'headless model'
      ? await distillSession(ports, { sessionId: 's1' })
      : await postAgentGene(ports, { sessionId: 's1', text: JSON.stringify(IR), writtenFor });
    t.mock.timers.reset();
    if (entry === 'headless model') assert.equal(signal.aborted, true, entry);
    assert.equal(writes, 3, entry);
    assert.equal(distills(requests).length, 1, entry);
    assert.deepEqual(await correctionsOf(ports), ['still failing'], entry);
    assert.deepEqual((await ports.drafts.read()).map(({ id }) => id), [DRAFTED.distill_id], entry);
    assert.equal(outcome.status, 'cleanup_failed', entry);
    assert.equal(distillText(outcome).ok, false, entry);
    assert.match(distillText(outcome).text, /could not remove its draft/i, entry);
    ports.drafts.update = update;
    await correct(ports);
    assert.deepEqual(await ports.drafts.read(), [], entry);
  }
});

test('a draft distillation could not take back stays unpublishable', async () => {
  const { ports, requests } = await fixedSession({
    model: modelAnswering(IR),
    distillAnswer: { ...DRAFTED, publishable: true, publish_receipt: { receiptId: 'proxy-issued-receipt' } },
  });
  const updateDrafts = ports.drafts.update;
  ports.drafts.update = async (mutate) => {
    const written = await updateDrafts(mutate);
    await ports.candidates.update((pending) => ({ ...pending, s1: { ...pending.s1, at: pending.s1.at + 1 } }));
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
  const { ports } = await fixedSession({ model: modelAnswering(IR) });
  const updateDrafts = ports.drafts.update;
  let writes = 0;
  ports.drafts.update = async (mutate) => {
    if (++writes === 2) {
      ports.drafts.update = async () => { throw new Error('draft cleanup denied'); };
      try {
        await assert.rejects(correct(ports), /draft cleanup denied/);
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

test('a session still active keeps its work waiting; once it is quiet, a prompt in any session schedules the distillation', async () => {
  const { ports, scheduled, advance } = await threeTurnSession({ model: modelAnswering(IR) });
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
  const made = await fixedSession({ model: modelAnswering(IR, async () => {
    completions += 1;
    started.resolve();
    await finish.promise;
  }) });
  await sessionEnded(made.ports, { sessionId: 's1', projectDir: '/proj' });
  const background = distillDue(made.ports);
  await started.promise;
  const explicit = distillSession(made.ports, { sessionId: 's1' });
  await new Promise(setImmediate);
  finish.resolve();
  const [outcomes, answer] = await Promise.all([background, explicit]);
  assert.equal(completions, 1);
  assert.equal(distills(made.requests).length, 1);
  assert.deepEqual([outcomes[0].status, answer.status], ['drafted', 'busy']);
  assert.equal((await made.ports.drafts.read()).length, 1);
});

test('with no model outside the conversation, a leftover waits a day for an agent\'s Gene, then is dropped', async () => {
  const { ports } = await fixedSession();
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  await runBackgroundTasks(ports, [TASKS.DISTILL]);
  assert.ok((await ports.candidates.read()).s1);
  await ports.clock.sleep(UNDISTILLED_LEFTOVER_TTL_MS + 1);
  await runBackgroundTasks(ports, [TASKS.DISTILL]);
  assert.equal((await ports.candidates.read()).s1, undefined);
});

test('a person who turned distillation off keeps the work from the background, and distills even one verified turn on demand', async () => {
  const made = memoryPorts({ distillAnswer: DRAFTED, project: PROJECT, model: modelAnswering(IR) });
  await changeTurn(made.ports, 's1');
  made.ports.settings = { recall: true, autoDistill: false };
  await sessionEnded(made.ports, { sessionId: 's1', projectDir: '/proj' });
  await runBackgroundTasks(made.ports, [TASKS.DISTILL]);
  assert.ok((await made.ports.candidates.read()).s1);
  assert.equal((await distillSession(made.ports, { sessionId: 's1' })).status, 'drafted');
});

test('a transient range watch read failure is retried without crashing the model run', async (t) => {
  const { ports, requests } = await fixedSession();
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  const reply = Promise.withResolvers();
  const started = Promise.withResolvers();
  ports.model = { complete: () => { started.resolve(); return reply.promise; } };
  const { setInterval } = globalThis;
  const { read } = ports.candidates;
  let check;
  t.mock.method(globalThis, 'setInterval', (callback) => { check = callback; return setInterval(() => {}, 60_000); });
  const running = distillDue(ports);
  t.after(async () => {
    ports.candidates.read = read;
    reply.resolve({ answer: JSON.stringify(IR) });
    await running;
  });
  await started.promise;
  ports.candidates.read = async () => { throw Object.assign(new Error('fixture read denial'), { code: 'EBUSY' }); };
  await assert.doesNotReject(check());
  assert.equal(distills(requests).length, 0);
  ports.candidates.read = read;
  reply.resolve({ answer: JSON.stringify(IR) });
  assert.equal((await running)[0].status, 'drafted');
  assert.equal(distills(requests).length, 1);
});

test('a process shutting down stops a leftover\'s model call without counting a try, and gives the claim back', async () => {
  const stopping = new AbortController();
  const waitsForever = { complete: (model, prompt, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))) };
  const { ports } = await fixedSession({ model: waitsForever });
  ports.scheduler = { ...ports.scheduler, signal: stopping.signal };
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  const running = distillDue(ports);
  await new Promise((resolve) => setImmediate(resolve));
  stopping.abort();
  assert.deepEqual((await running).map((outcome) => outcome.status), ['stopped']);
  const { s1 } = await ports.candidates.read();
  assert.deepEqual([s1.attempts, s1.claimedBy ?? null], [0, null]);
});

test('the model may decline, which settles the session\'s work without calling the Proxy', async () => {
  const made = await fixedSession({ model: modelAnswering({ skip: 'routine edit' }) });
  const [outcome] = await endedAndDistilled(made);
  assert.deepEqual([outcome.status, outcome.reason], ['declined', 'routine edit']);
  assert.deepEqual(distills(made.requests), []);
  assert.equal((await made.ports.candidates.read()).s1, undefined);
});

test('a failing headless model keeps the work, tries again only after a doubling wait, and three failed tries give it up', async () => {
  const { ports, advance } = await fixedSession({ model: { complete: async () => { throw new Error('Authentication required'); } } });
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

test('an unavailable captured route parks the range without a try, past the leftover expiry, until that route returns', async () => {
  const route = { available: false };
  const made = await fixedSession({ model: routedModel(route) });
  const { ports, requests, wakeUps } = made;
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  assert.deepEqual(await distillDue(ports), [{ status: 'blocked', reason: 'route_changed' }]);
  const range = (await ports.candidates.read()).s1;
  assert.deepEqual([range.attempts, range.claimedBy, range.blocked], [0, null, { reason: 'route_changed', at: ports.clock.now() }]);
  assert.deepEqual(distills(requests), []);
  await armDistillWakeUp(ports);
  assert.deepEqual(wakeUps.at(-1), { at: range.blocked.at + BLOCKED_ROUTE_TTL_MS, tasks: [TASKS.DISTILL] });
  made.advance(UNDISTILLED_LEFTOVER_TTL_MS + 1);
  await dropExpiredLeftovers(ports);
  assert.ok((await ports.candidates.read()).s1);
  route.available = true;
  assert.equal((await distillSession(ports, { sessionId: 's1' })).status, 'drafted');
  assert.equal((await ports.candidates.read()).s1, undefined);
});

test('a blocked route stays parked when another session wakes the distillation worker', async () => {
  const route = { available: false };
  const { ports, requests, scheduled } = await fixedSession({ model: routedModel(route) });
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  assert.deepEqual(await distillDue(ports), [{ status: 'blocked', reason: 'route_changed' }]);
  scheduled.length = 0;
  await scheduleDueDistillation(ports);
  const scheduledWhileBlocked = [...scheduled];
  route.available = true;
  await fixTurn(ports, 's2');
  await sessionEnded(ports, { sessionId: 's2', projectDir: '/proj' });
  await distillDue(ports);
  assert.equal(route.calls, 2, 'the worker should only run the newly due session');
  assert.deepEqual(scheduledWhileBlocked, []);
  assert.deepEqual(distills(requests).map(({ body }) => body.session_id), ['testagent:s2']);
  assert.equal((await ports.candidates.read()).s1.blocked.reason, 'route_changed');
});

test('a blocked range expires from its first block even after a failed manual retry', async () => {
  const route = { available: false };
  const { ports, advance, wakeUps } = await fixedSession({ model: routedModel(route) });
  advance(EPISODE_QUIET_MS);
  await runBackgroundTasks(ports, [TASKS.DISTILL]);
  const deadline = ports.clock.now() + BLOCKED_ROUTE_TTL_MS;
  assert.deepEqual(wakeUps.at(-1), { at: deadline, tasks: [TASKS.DISTILL] });
  advance(BLOCKED_ROUTE_TTL_MS - 1);
  ports.settings = { autoDistill: false };
  assert.equal((await distillSession(ports, { sessionId: 's1' })).status, 'blocked');
  assert.deepEqual(wakeUps.at(-1), { at: deadline, tasks: [TASKS.DISTILL] });
  advance(1);
  assert.equal(await runBackgroundTasks(ports, [TASKS.DISTILL]), true);
  assert.equal((await ports.candidates.read()).s1, undefined);
  assert.equal(route.calls, 2);
});

test('an expired legacy block is pruned without interrupting a live manual claim', async () => {
  const { ports, advance } = await fixedSession({ model: { capture: () => 'model-x', complete: () => assert.fail('expiry must not call the model') } });
  await fixTurn(ports, 's2');
  const blocked = { reason: 'route_changed' };
  await ports.candidates.update((pending) => ({ ...pending, s1: { ...pending.s1, blocked, claimedBy: ports.owner.self() }, s2: { ...pending.s2, blocked } }));
  advance(BLOCKED_ROUTE_TTL_MS);
  assert.deepEqual(await distillDue(ports), []);
  assert.deepEqual(Object.keys(await ports.candidates.read()), ['s1']);
  assert.equal((await distillSession(ports, { sessionId: 's1' })).status, 'busy');
  await ports.candidates.update((pending) => ({ ...pending, s1: { ...pending.s1, claimedBy: null } }));
  assert.deepEqual(await distillSession(ports, { sessionId: 's1' }), { status: 'nothing' });
  assert.equal((await ports.candidates.read()).s1, undefined);
});

test('a range without a captured route is settled without a model call, and never on the current route', async () => {
  const { ports, requests } = await fixedSession({ model: {
    capture: () => assert.fail('the current route cannot stand in for the original route'),
    complete: () => assert.fail('a range without a captured route cannot call a model'),
  } });
  await ports.candidates.update((pending) => ({ ...pending, s1: { ...pending.s1, model: null } }));
  const outcome = await distillSession(ports, { sessionId: 's1' });
  assert.deepEqual(outcome, { status: 'route_not_captured' });
  assert.match(distillText(outcome).text, /finish a new work turn/i);
  assert.equal((await ports.candidates.read()).s1, undefined);
  await fixTurn(ports, 's2');
  await ports.candidates.update((pending) => ({ ...pending, s2: { ...pending.s2, model: null, blocked: { reason: 'route_unresolved' } } }));
  await sessionEnded(ports, { sessionId: 's2', projectDir: '/proj' });
  assert.deepEqual(await distillDue(ports), [{ status: 'route_not_captured' }], 'a range blocked before without a route can settle');
  assert.equal((await ports.candidates.read()).s2, undefined);
  assert.deepEqual(distills(requests), []);
});

const pass = (command = 'npm test') => ({ kind: 'check', command, exit: 0, failed: false });
const turnWith = (turn, steps) => ({ turn, prompt: 'p', steps, answer: '', at: 1 });
const FIXED = [turnWith(1, [{ ...pass(), exit: 1, failed: true }, { kind: 'edit', path: 'a.js' }, pass()])];
const SMALL = [turnWith(1, [{ kind: 'edit', path: 'a.js' }, pass()])];

test('the next wake-up is when the earliest range no live process holds comes due', () => {
  const NOW = 10 * IDLE_DISTILL_MS;
  const LIVE = 1;
  const DEAD = 2;
  const isGone = (pid) => pid === DEAD;
  const range = (fields, turns = SMALL) => ({ turns, at: NOW - 5_000, ...fields });
  const rows = [
    ['quiet once its session has been idle long enough', { s1: range({ activeAt: NOW - 1_000, pid: LIVE }) }, NOW - 1_000 + IDLE_DISTILL_MS],
    ['sooner after a fixed error', { s1: range({ activeAt: NOW - 1_000, pid: LIVE }, FIXED) }, NOW - 1_000 + EPISODE_QUIET_MS],
    ['below the threshold, waiting for more work', { s1: range({ activeAt: NOW - 1_000, pid: LIVE, held: true }) }, null],
    ['a retry later than the quiet deadline', { s1: range({ activeAt: NOW - 1_000, pid: LIVE, retryAt: NOW + IDLE_DISTILL_MS }) }, NOW + IDLE_DISTILL_MS],
    ['claimed by a live process, which settles it', { s1: range({ activeAt: NOW - 1_000, pid: LIVE, claimedBy: LIVE }) }, null],
    ['over and waiting out its retry', { s1: range({ activeAt: NOW - 1_000, pid: DEAD, retryAt: NOW + RETRY_BASE_MS }) }, NOW + RETRY_BASE_MS],
    ['one due already, as due now', { due: range({ activeAt: NOW - IDLE_DISTILL_MS, pid: LIVE }), later: range({ activeAt: NOW - 1_000, pid: LIVE }) }, NOW],
    ['none', {}, null],
  ];
  for (const [name, pending, expected] of rows) assert.equal(nextDueAt(pending, { now: NOW, isGone }), expected, name);
});

test('a wake-up keeps a range\'s own time when it is still to come, and waits a minute for one already due', async () => {
  const { ports, wakeUps } = memoryPorts({ model: { complete: async () => ({ answer: '' }) } });
  const now = ports.clock.now();
  await ports.candidates.update(() => ({ soon: { turns: SMALL, at: now, activeAt: now + 10_000 - IDLE_DISTILL_MS, pid: 1 } }));
  await armDistillWakeUp(ports);
  await ports.candidates.update(() => ({ due: { turns: SMALL, at: now, activeAt: now - IDLE_DISTILL_MS, pid: 1 } }));
  await armDistillWakeUp(ports);
  assert.deepEqual(wakeUps.map(({ at }) => at), [now + 10_000, now + MIN_WAKE_DELAY_MS]);
});

test('with no headless model, distilling now hands the agent the IR prompt, and its IR becomes a draft', async () => {
  const { ports } = await fixedSession({ distillAnswer: { ...DRAFTED, publishable: true, publish_receipt: { receiptId: 'proxy-issued-receipt' } } });
  const asked = await distillSession(ports, { sessionId: 's1' });
  assert.equal(asked.status, 'no_model');
  assert.match(asked.agentGene.prompt, /^Evolver distillation, prompt session-gene-ir-v1\.[\s\S]*## Kind: fix[\s\S]*\nR3 check \(exit 1\): npm test\n/);
  assert.ok((await ports.candidates.read()).s1);
  const posted = await postAgentGene(ports, { sessionId: 's1', text: JSON.stringify([IR]), writtenFor: asked.agentGene.writtenFor });
  assert.equal(posted.status, 'drafted');
  const listed = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts' });
  assert.match(listed.text, /Stabilise Redis retries/);
  const published = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'publish 1' });
  assert.match(published.text, /^Submitted "Stabilise Redis retries"/);
  assert.equal((await ports.drafts.read()).length, 0);
});

test('a draft write failure releases the claim so the same process can retry', async () => {
  const { ports } = await fixedSession({ distillAnswer: DRAFTED });
  const asked = await distillSession(ports, { sessionId: 's1' });
  const submission = { sessionId: 's1', text: JSON.stringify(IR), writtenFor: asked.agentGene.writtenFor };
  const updateDrafts = ports.drafts.update;
  ports.drafts.update = async () => { throw new Error('disk full'); };

  await assert.rejects(postAgentGene(ports, submission), /disk full/);
  ports.drafts.update = updateDrafts;

  assert.equal((await postAgentGene(ports, submission)).status, 'drafted');
  assert.equal((await ports.drafts.read()).length, 1);
  assert.equal((await ports.candidates.read()).s1, undefined);
});

test('an IR written for the session\'s work as it was before another turn joined it, or for a range made again at the same time, is not sent', async () => {
  const { ports, requests } = await fixedSession();
  const asked = await distillSession(ports, { sessionId: 's1' });
  const before = (await ports.candidates.read()).s1;
  await changeTurn(ports, 's1', 2);
  const gene = { sessionId: 's1', text: JSON.stringify(IR) };
  assert.equal((await postAgentGene(ports, { ...gene, writtenFor: asked.agentGene.writtenFor })).status, 'dropped');
  assert.equal((await postAgentGene(ports, { ...gene, writtenFor: before.changedAt })).status, 'dropped');
  assert.deepEqual(distills(requests), []);
  const fresh = await distillSession(ports, { sessionId: 's1' });
  assert.notEqual(fresh.agentGene.writtenFor, asked.agentGene.writtenFor);
  assert.equal((await postAgentGene(ports, { ...gene, writtenFor: fresh.agentGene.writtenFor })).status, 'drafted');
  await fixTurn(ports, 's1');
  const renewed = (await ports.candidates.read()).s1;
  assert.deepEqual([renewed.at, renewed.changedAt], [before.at, before.changedAt]);
  assert.equal((await postAgentGene(ports, { ...gene, writtenFor: asked.agentGene.writtenFor })).status, 'dropped');
});

test('a terminal\'s IR selects its session by reference even when another range has the same times', async () => {
  const { ports, requests } = await fixedSession();
  await fixTurn(ports, 's2');
  const { s1, s2 } = await ports.candidates.read();
  assert.deepEqual([s1.at, s1.changedAt], [s2.at, s2.changedAt]);
  const { agentGene } = await distillSession(ports, { sessionId: 's2' });
  const gene = { text: JSON.stringify(IR), writtenFor: agentGene.writtenFor };
  assert.equal((await postAgentGene(ports, { ...gene, sessionId: 's1' })).status, 'dropped');
  assert.equal((await postAgentGene(ports, { ...gene, sessionId: 'terminal', anySession: true })).status, 'drafted');
  assert.deepEqual(distills(requests).map(({ body }) => body.session_id), ['testagent:s2']);
  assert.equal((await ports.candidates.read()).s1.changedAt, s1.changedAt);
});

test('every command answers from the plugin; evolve is the one prompt for the agent', async () => {
  const { ports } = memoryPorts();
  assert.equal((await runCommand(ports, { sessionId: 's1', name: 'evolver-sync', args: '--dry-run "two words"' })).text, 'ran sync --dry-run two words');
  assert.equal((await runCommand(ports, { sessionId: 's1', name: 'evolver-evolve' })).forAgent, true);
  assert.match((await runCommand(ports, { sessionId: 's1', name: 'evolver-status' })).text, /No work turn of this session waits to be distilled\.\nNo distillation has run yet\./);
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
