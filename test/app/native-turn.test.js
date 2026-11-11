import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reconcileNativeTurn, recoverNativeTurns, turnObservationOf } from '../../lib/app/native-turn.js';
import { runBackgroundTasks } from '../../lib/app/background.js';
import { promptSubmitted } from '../../lib/app/prompt.js';
import { sessionStarted } from '../../lib/app/session-start.js';
import { sessionEnded } from '../../lib/app/session-end.js';
import { TASKS } from '../../lib/app/ports.js';
import { armDistillWakeUp, distillDue, distillSession, dropExpiredLeftovers } from '../../lib/app/distill-session.js';
import { BLOCKED_ROUTE_TTL_MS, IDLE_DISTILL_MS, rangeOf, UNDISTILLED_LEFTOVER_TTL_MS } from '../../lib/distill/range.js';
import { memoryPorts, PROMPT } from './memory-ports.js';
import { changeTurn, IR } from './work-turns.js';

const route = { alias: 'route-b', providerId: 'account-b', model: 'upstream-b', protocol: 'openai', endpoint: 'https://api.example/v1', effort: 'off', binding: 'captured-account', configRevision: 'same-config' };
const modelHint = { alias: 'route-b', effort: 'off' };
const payload = { session_id: 'native-session', cwd: '/workspace' };
const at = { sessionId: 'session', projectDir: '/workspace', payload, turn: 1 };
const record = () => ({ commands: ['npm test'], paths: ['/workspace/file.js'], edits: ['/workspace/file.js'], checks: [{ command: 'npm test', failed: false }], answer: 'Fixed retries.' });
const facts = (terminal = true) => ({ status: 'ok', schemaSupported: true, schemaVersion: '1.5', mark: { offset: 500, fileId: 'wire' }, modelHint,
  bind: { turnId: '0', promptId: 'native-prompt', origin: 'user', mark: 120 },
  terminal: terminal ? { turnId: '0', reason: 'completed', answer: 'Fixed retries.', modelHint: { ...modelHint, model: 'upstream-b', protocol: 'openai' } } : null,
  record: record() });

function legacyCandidate({ commands, paths, checks, answer }, { now, sessionEpoch, finalizationPending = false }) {
  return { prompt: PROMPT, commands, paths, checks, answer, model: route, turn: 1, pid: 4242, attempts: 0, at: now,
    ...(sessionEpoch !== undefined && { sessionEpoch }), ...(finalizationPending && { finalizationPending: true }) };
}

function fixedErrorFacts() {
  const observed = facts();
  observed.record.checks.unshift({ command: 'npm test', exit: 1, failed: true });
  return observed;
}

async function pending(options = {}) {
  const made = memoryPorts(options);
  await promptSubmitted(made.ports, { sessionId: 'session', prompt: PROMPT, waitMs: 500 });
  await made.ports.sessions.update('session', stored => ({ ...stored, native: { turn: 1, payload, mark: { offset: 100, fileId: 'wire' }, turnId: null, model: route, modelHint, schemaVersion: '1.5' } }));
  made.ports.model = { capture: () => ({ ...route }) };
  made.ports.native = { read: async () => facts() };
  return made;
}

test('native prompt binds turn zero before terminal; Stop hints cannot close it early', async () => {
  const made = await pending();
  const observed = await reconcileNativeTurn(made.ports, at, facts(false));
  assert.equal(observed.waiting, true);
  assert.equal(made.sessions.get('session').turnId, '0');
  assert.equal(made.sessions.get('session').open, true);
  assert.deepEqual(made.queued, []);
  const ended = await reconcileNativeTurn(made.ports, at, facts());
  assert.equal(ended.ended.isCandidate, true);
  assert.equal(made.sessions.get('session').open, false);
  assert.deepEqual((await made.ports.candidates.read()).session.model, route);
  assert.equal(made.queued.length, 1);
  assert.deepEqual(made.wakeUps, [{ at: made.ports.clock.now() + IDLE_DISTILL_MS, tasks: [TASKS.DISTILL] }]);
  await reconcileNativeTurn(made.ports, at, facts());
  assert.equal(made.queued.length, 1);
  assert.equal(made.wakeUps.length, 1, 'an already activated candidate does not schedule another wake');
  assert.deepEqual(made.sessions.get('session').nativeCursor.mark, { offset: 500, fileId: 'wire' });
});

test('native finalization preserves an unknown captured owner without probing its own ancestry', async () => {
  const made = await pending({ owner: null });
  made.ports.owner.current = () => assert.fail('finalization must use the captured owner');
  const ended = await reconcileNativeTurn(made.ports, at, facts());
  assert.equal(ended.ended.isCandidate, true);
  assert.equal((await made.ports.candidates.read()).session.pid, null);
  assert.equal(made.queued.length, 1);
});

test('read errors, partial wire and a native prompt before the pending mark cannot settle a turn', async () => {
  for (const bad of [{ ...facts(), status: 'partial' }, { ...facts(), bind: { ...facts().bind, mark: 50 } }, { ...facts(), mark: { offset: 500, fileId: 'rotated' } }]) {
    const made = await pending();
    await reconcileNativeTurn(made.ports, at, bad);
    assert.equal(made.sessions.get('session').open, true);
    assert.deepEqual(made.queued, []);
  }
  const made = await pending();
  made.ports.native.read = async () => { throw new Error('unreadable'); };
  const result = await reconcileNativeTurn(made.ports, at);
  assert.equal(result.facts.status, 'unreadable');
  assert.equal(made.sessions.get('session').open, true);
});

test('recovery settles a healthy native session even when the state scan reports a corrupt sibling', async () => {
  const made = await pending();
  const updateEach = made.ports.sessions.updateEach;
  const error = new Error('invalid session state');
  made.ports.sessions.updateEach = async mutate => {
    await updateEach(mutate);
    throw error;
  };
  await assert.rejects(recoverNativeTurns(made.ports), error);
  assert.deepEqual((await made.ports.candidates.read()).session.turns.map(({ turn }) => turn), [1]);
  assert.equal(made.sessions.get('session').open, false);
});

test('a background distill command asks for a new work turn when the captured route cannot be verified', async () => {
  const made = await pending();
  const observed = facts();
  observed.terminal.modelHint.model = 'unmatched-native-model';
  made.ports.model.complete = () => assert.fail('an unresolved account must not request a model');
  await reconcileNativeTurn(made.ports, at, observed);
  made.ports.commandJobs = {
    async run(id, run) {
      assert.equal(id, 'distill-job');
      const result = await run({ sessionId: 'session', name: 'evolver-distill' }, new AbortController().signal);
      assert.equal(result.ok, false);
      assert.equal(result.text, "The session's work has no captured model route. Finish a new work turn so Evolver can capture its model route.");
      return true;
    },
  };
  assert.equal(await runBackgroundTasks(made.ports, ['command:distill-job']), true);
  assert.deepEqual(await made.ports.candidates.read(), {});
  assert.equal(made.requests.some(request => request.path === '/conversation/distill'), false);
});

test('late background verification only rejudges its original still-last turn', async () => {
  const made = await pending();
  const running = facts(); running.record.checks[0].failed = null; running.pendingVerification = true;
  assert.equal((await reconcileNativeTurn(made.ports, at, running)).waiting, true);
  assert.deepEqual(await made.ports.candidates.read(), {});
  await reconcileNativeTurn(made.ports, at, facts());
  assert.deepEqual((await made.ports.candidates.read()).session.turns.map(({ turn }) => turn), [1]);
  assert.equal(made.queued.length, 1);
  await promptSubmitted(made.ports, { sessionId: 'session', prompt: 'Continue a different task.', waitMs: 500 });
  await reconcileNativeTurn(made.ports, at, facts());
  assert.equal(made.sessions.get('session').open, true);
  assert.equal(made.sessions.get('session').turn, 2);
  assert.equal(made.queued.length, 1);
});

test('temporary account drift preserves the captured binding for retry while an actual native route mismatch stays unresolved', async () => {
  const changed = await pending();
  changed.ports.model.capture = () => ({ ...route, binding: 'other-account' });
  await reconcileNativeTurn(changed.ports, at, facts());
  assert.deepEqual((await changed.ports.candidates.read()).session.model, route);
  const wrong = await pending();
  const observed = facts(); observed.terminal.modelHint.model = 'wrong-model';
  await reconcileNativeTurn(wrong.ports, at, observed);
  assert.equal((await wrong.ports.candidates.read()).session.model, null);
});

test('a missing or unmatched native model binding settles on the first distill without using a model', async () => {
  for (const missingCapture of [true, false]) {
    const made = await pending({ gone: new Set([4242]) });
    const observed = facts();
    if (missingCapture) await made.ports.sessions.update('session', stored => ({ ...stored, native: { ...stored.native, model: null } }));
    else observed.terminal.modelHint.model = 'unmatched-native-model';
    made.ports.model.complete = () => assert.fail('an unresolved account must not request a model');
    await reconcileNativeTurn(made.ports, at, observed);
    assert.deepEqual(await distillDue(made.ports), [{ status: 'route_not_captured' }]);
    assert.deepEqual(await made.ports.candidates.read(), {});
    await reconcileNativeTurn(made.ports, at, observed);
    assert.deepEqual(await distillDue(made.ports), []);
    assert.deepEqual(await made.ports.candidates.read(), {});
    assert.equal(made.requests.some(request => request.path === '/conversation/distill'), false);
  }
});

test('a known dead owner is reconciled from terminal wire before orphan abort reporting', async () => {
  const made = await pending({ gone: new Set([4242]) });
  made.ports.owner.current = () => 9999;
  await recoverNativeTurns(made.ports);
  await sessionStarted(made.ports, { sessionId: 'new-session', projectDir: '/workspace' });
  assert.equal(made.queued.length, 1);
  assert.equal(made.queued[0].report.outcome, 'success');
  assert.equal((await made.ports.candidates.read()).session.pid, 4242);
});

test('a prompt, owner or epoch change during a native read cannot close a newer unbound turn', async () => {
  for (const change of [
    made => promptSubmitted(made.ports, { sessionId: 'session', prompt: 'New task.', waitMs: 500 }),
    made => made.ports.sessions.update('session', stored => ({ ...stored, pid: 9999 })),
    made => made.ports.sessions.update('session', stored => ({ ...stored, sessionEpoch: stored.sessionEpoch + 1 })),
  ]) {
    const made = await pending();
    made.ports.native.read = async () => { await change(made); return facts(); };
    await reconcileNativeTurn(made.ports, at);
    assert.equal(made.sessions.get('session').open, true);
    assert.deepEqual(await made.ports.candidates.read(), {});
    assert.deepEqual(made.queued, []);
  }
});

test('a queued reconciliation from an older epoch stops before reading the new wire', async () => {
  const made = await pending();
  made.ports.native.read = () => assert.fail('the recreated session is outside this job');
  const result = await reconcileNativeTurn(made.ports, { ...at, sessionEpoch: made.sessions.get('session').sessionEpoch - 1 });
  assert.equal(result.facts, null);
  assert.equal(result.waiting, false);
  assert.equal(made.sessions.get('session').open, true);
  assert.deepEqual(await made.ports.candidates.read(), {});
});

test('a duplicate terminal cannot recreate an explicitly discarded candidate', async () => {
  const made = await pending();
  await reconcileNativeTurn(made.ports, at, facts());
  await made.ports.candidates.update(() => ({}));
  await reconcileNativeTurn(made.ports, at, facts());
  assert.deepEqual(await made.ports.candidates.read(), {});
});

test('a correction arriving during native candidate persistence cannot leave the older candidate behind', async () => {
  const made = await pending();
  const writing = Promise.withResolvers(), resume = Promise.withResolvers();
  const update = made.ports.candidates.update;
  let held = false;
  made.ports.candidates.update = async mutate => {
    if (!held) {
      held = true;
      writing.resolve();
      await resume.promise;
    }
    return update(mutate);
  };
  const finishing = reconcileNativeTurn(made.ports, at, facts());
  await writing.promise;
  try {
    await promptSubmitted(made.ports, { sessionId: 'session', prompt: 'That is wrong. Revert the change.', waitMs: 500 });
    assert.equal(made.sessions.get('session').correctedTurn, 1);
  } finally { resume.resolve(); }
  assert.equal((await finishing).ended.isCandidate, false);
  assert.deepEqual(await made.ports.candidates.read(), {});
  assert.equal((await distillSession(made.ports, { sessionId: 'session' })).status, 'nothing');
});

test('session end preserves a pending native turn and its original prompt for late task completion', async () => {
  const made = await pending();
  const running = facts(); running.record.checks[0].failed = null; running.pendingVerification = true;
  await reconcileNativeTurn(made.ports, at, running);
  await sessionEnded(made.ports, at);
  assert.equal(made.sessions.get('session').native.pending, true);
  await reconcileNativeTurn(made.ports, at, facts());
  const candidate = (await made.ports.candidates.read()).session;
  assert.deepEqual(candidate.turns.map(({ prompt }) => prompt), [PROMPT]);
  assert.equal(candidate.closed, true);
  assert.equal(made.queued.length, 1);
});

test('a native finalization claim covers the candidate-consumed window before the settled marker is written', async () => {
  const made = await pending({ distillAnswer: { status: 'stored' } });
  let completions = 0;
  made.ports.model.complete = async () => { completions++; return { answer: JSON.stringify(IR) }; };
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), update = made.ports.sessions.update;
  let held = false;
  made.ports.sessions.update = async (id, mutate) => {
    const next = await update(id, mutate);
    if (!held && next && !next.open && next.settling === null && next.native?.turnId === '0' && !next.native.settled) {
      held = true; entered.resolve(); await release.promise;
    }
    return next;
  };
  const first = reconcileNativeTurn(made.ports, at, facts());
  await entered.promise;
  assert.equal((await distillSession(made.ports, { sessionId: 'session' })).status, 'busy');
  await reconcileNativeTurn(made.ports, at, facts());
  assert.equal(completions, 0);
  release.resolve(); await first;
  assert.equal((await distillSession(made.ports, { sessionId: 'session' })).status, 'stored');
  await reconcileNativeTurn(made.ports, at, facts());
  assert.deepEqual(await made.ports.candidates.read(), {});
  assert.equal(completions, 1);
});

test('native work survives failed finalization writes without being consumed or recreated', async () => {
  for (const stage of ['marker', 'activation']) {
    const made = await pending({ distillAnswer: { status: 'stored' }, gone: new Set([4242]) });
    let completions = 0, failed = false;
    made.ports.model.complete = async () => { completions++; return { answer: JSON.stringify(IR) }; };
    const sessionUpdate = made.ports.sessions.update, candidateUpdate = made.ports.candidates.update;
    if (stage === 'marker') {
      made.ports.sessions.update = (id, mutate) => sessionUpdate(id, stored => {
        const next = mutate(stored);
        if (!failed && next?.native?.settled && !stored.native?.settled) {
          failed = true; throw Object.assign(new Error('session replacement failed'), { code: 'EACCES' });
        }
        return next;
      });
    } else {
      made.ports.candidates.update = mutate => candidateUpdate(pending => {
        const next = mutate(pending);
        if (!failed && pending.session?.turns[0]?.finalizationPending === true && next?.session && next.session.turns[0]?.finalizationPending !== true) {
          failed = true; throw Object.assign(new Error('candidate activation failed'), { code: 'EACCES' });
        }
        return next;
      });
    }
    await assert.rejects(reconcileNativeTurn(made.ports, at, facts()), { code: 'EACCES' });
    assert.equal((await made.ports.candidates.read()).session.turns[0].finalizationPending, true);
    assert.equal((await distillSession(made.ports, { sessionId: 'session' })).status, 'busy');
    assert.deepEqual(await distillDue(made.ports), []);
    made.advance(UNDISTILLED_LEFTOVER_TTL_MS + 1);
    await dropExpiredLeftovers(made.ports);
    assert.ok((await made.ports.candidates.read()).session, 'unfinished persistence must retain its candidate past expiry');
    assert.equal(completions, 0);
    made.ports.sessions.update = sessionUpdate; made.ports.candidates.update = candidateUpdate;
    await recoverNativeTurns(made.ports);
    assert.notEqual((await made.ports.candidates.read()).session.turns[0].finalizationPending, true);
    assert.ok(made.scheduled.includes(TASKS.DISTILL), 'recovered activation schedules the due candidate without another host event');
    assert.equal((await distillSession(made.ports, { sessionId: 'session' })).status, 'stored');
    await reconcileNativeTurn(made.ports, at, facts());
    assert.deepEqual(await made.ports.candidates.read(), {});
    assert.equal(completions, 1);
  }
});

test('a later prompt cannot strand an older pending candidate when activation needs recovery', async () => {
  const made = await pending({ distillAnswer: { status: 'stored' } });
  let completions = 0, held = false, failed = false;
  made.ports.model.complete = async () => { completions++; return { answer: JSON.stringify(IR) }; };
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const sessionUpdate = made.ports.sessions.update, candidateUpdate = made.ports.candidates.update;
  made.ports.sessions.update = async (id, mutate) => {
    const next = await sessionUpdate(id, mutate);
    if (!held && next && !next.open && next.settling === null && next.native?.turnId === '0' && !next.native.settled) {
      held = true; entered.resolve(); await release.promise;
    }
    return next;
  };
  made.ports.candidates.update = mutate => candidateUpdate(pending => {
    const next = mutate(pending);
    if (!failed && pending.session?.turns[0]?.finalizationPending === true && next?.session && next.session.turns[0]?.finalizationPending !== true) {
      failed = true; throw Object.assign(new Error('activation replacement failed'), { code: 'EACCES' });
    }
    return next;
  });
  const first = reconcileNativeTurn(made.ports, at, facts());
  const rejected = assert.rejects(first, { code: 'EACCES' });
  await entered.promise;
  await promptSubmitted(made.ports, { sessionId: 'session', prompt: 'Now update unrelated documentation.', waitMs: 500 });
  await made.ports.sessions.update('session', stored => ({ ...stored, native: { turn: 2, payload, mark: facts().mark, model: route, modelHint, schemaVersion: '1.5' } }));
  release.resolve(); await rejected;
  assert.equal((await distillSession(made.ports, { sessionId: 'session' })).status, 'busy');
  await recoverNativeTurns(made.ports);
  assert.equal((await distillSession(made.ports, { sessionId: 'session' })).status, 'stored');
  await reconcileNativeTurn(made.ports, at, facts());
  assert.deepEqual(await made.ports.candidates.read(), {});
  assert.equal(completions, 1);
  assert.equal(made.sessions.get('session').open, true);
  assert.equal(made.sessions.get('session').turn, 2);
});

test('session end crossing first finalization closes the eventual candidate while its owner is still alive', async () => {
  const made = await pending({ distillAnswer: { status: 'stored' } });
  made.ports.model.complete = async () => ({ answer: JSON.stringify(IR) });
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), enqueue = made.ports.reports.enqueue;
  let held = false;
  made.ports.reports.enqueue = async entries => {
    if (!held) { held = true; entered.resolve(); await release.promise; }
    return enqueue(entries);
  };
  const first = reconcileNativeTurn(made.ports, at, fixedErrorFacts());
  await entered.promise;
  await sessionEnded(made.ports, at);
  release.resolve(); await first;
  assert.equal(made.ports.owner.isGone(4242), false);
  assert.equal((await made.ports.candidates.read()).session.closed, true);
  assert.deepEqual((await distillDue(made.ports)).map(outcome => outcome.status), ['stored']);
});

test('native claims refuse a live holder without TTL takeover and recover a dead stale holder', async () => {
  const gone = new Set(), made = await pending({ gone });
  await made.ports.sessions.update('session', stored => ({ ...stored, open: false, turnId: '0', settling: made.ports.clock.now(), native: { ...stored.native, turnId: '0', promptId: 'native-prompt', finalizingPid: 9999 } }));
  made.advance(60_000);
  await reconcileNativeTurn(made.ports, at, facts());
  assert.deepEqual(await made.ports.candidates.read(), {});
  gone.add(9999);
  await reconcileNativeTurn(made.ports, at, facts());
  assert.deepEqual((await made.ports.candidates.read()).session.turns.map(({ turn }) => turn), [1]);
  assert.equal(made.sessions.get('session').native.finalizingPid, null);
});

test('failed and cancelled native turns stop polling pending checks that cannot become candidates', async () => {
  for (const reason of ['failed', 'cancelled', 'interrupted']) {
    const made = await pending();
    const terminal = facts(); terminal.terminal.reason = reason; terminal.record.checks[0].failed = null;
    assert.equal((await reconcileNativeTurn(made.ports, at, terminal)).waiting, false);
    assert.equal(made.sessions.get('session').native.pending, false);
    assert.deepEqual(await made.ports.candidates.read(), {});
  }
});

test('a completed foreground check with an unknown verdict stops polling without becoming a candidate', async () => {
  const made = await pending();
  const observed = facts();
  observed.record.checks[0] = { command: 'npm test', exit: null, failed: null };
  observed.pendingVerification = false;

  const result = await reconcileNativeTurn(made.ports, at, observed);
  assert.equal(result.waiting, false, 'a completed tool result cannot gain evidence by polling again');
  assert.equal(result.ended.isCandidate, false);
  assert.equal(made.sessions.get('session').open, false);
  assert.equal(made.sessions.get('session').native.pending, true, 'an unknown check remains ineligible for distillation');
  assert.deepEqual(await made.ports.candidates.read(), {});
  assert.deepEqual(await distillDue(made.ports), []);
  assert.equal(made.requests.some(({ path }) => path === '/conversation/distill'), false);
});

test('a legacy route-blocked native candidate with an unknown check still schedules expiry', async () => {
  const made = await pending();
  const { ports } = made;
  const at = ports.clock.now();
  const verified = record();
  verified.checks.push({ command: 'npm run lint', failed: null });
  const candidate = legacyCandidate(verified, { now: at });
  await ports.candidates.update(() => ({ session: { ...candidate, blocked: { reason: 'route_changed', at } } }));
  ports.model.complete = () => assert.fail('expiry must not request a model');

  assert.equal((await distillSession(ports, { sessionId: 'session' })).status, 'busy');
  await armDistillWakeUp(ports);
  assert.deepEqual(made.wakeUps, [{ at: at + BLOCKED_ROUTE_TTL_MS, tasks: [TASKS.DISTILL] }]);
  made.advance(BLOCKED_ROUTE_TTL_MS);
  assert.deepEqual(await distillDue(ports), []);
  assert.deepEqual(await ports.candidates.read(), {});
});

test('a pending background check blocks native distillation until dead-owner recovery sees its result', async () => {
  const made = await pending({ distillAnswer: { status: 'stored' }, gone: new Set([4242]) });
  let completions = 0;
  made.ports.model.complete = async () => { completions++; return { answer: JSON.stringify(IR) }; };
  const observed = fixedErrorFacts();
  observed.record.checks.unshift({ command: 'npm run lint', failed: null });
  observed.pendingVerification = true;
  made.ports.native.read = async () => observed;
  const first = await reconcileNativeTurn(made.ports, at, observed);
  assert.equal(first.waiting, true);
  assert.equal(first.ended.isCandidate, false);
  assert.equal((await distillSession(made.ports, { sessionId: 'session' })).status, 'nothing');
  assert.equal((await recoverNativeTurns(made.ports))[0].waiting, true);
  assert.deepEqual(await distillDue(made.ports), []);
  assert.equal(completions, 0);
  assert.equal(made.requests.some(({ path }) => path === '/conversation/distill'), false);
  assert.deepEqual(await made.ports.candidates.read(), {});

  observed.record.checks[0].failed = false;
  observed.pendingVerification = false;
  assert.equal((await recoverNativeTurns(made.ports))[0].waiting, false);
  assert.deepEqual((await distillDue(made.ports)).map(({ status }) => status), ['stored']);
  await recoverNativeTurns(made.ports);
  assert.deepEqual(await distillDue(made.ports), []);
  assert.deepEqual(await made.ports.candidates.read(), {});
  assert.equal(completions, 1);
  assert.equal(made.requests.filter(({ path }) => path === '/conversation/distill').length, 1);
});

test('a superseding native prompt clears an earlier check barrier without letting a late observation restore it', async () => {
  const { ports } = memoryPorts({ model: { capture: () => route } });
  await changeTurn(ports, at.sessionId, 1, { model: route });
  ports.native = { reference: (payload) => payload, read: async () => ({ status: 'unreadable' }) };
  const observation = turnObservationOf(ports);
  const open = async () => {
    const attach = await observation.capturePrompt(at, payload, { nativeFacts: { ...facts(false), mark: { offset: 100, fileId: 'wire' } } });
    const { turn, sessionEpoch } = await promptSubmitted(ports, { sessionId: at.sessionId, prompt: PROMPT, waitMs: 500 });
    await attach({ turn, sessionEpoch });
    return { turn, sessionEpoch };
  };
  const range = async () => rangeOf(await ports.candidates.read(), at.sessionId);
  const older = await open();
  const running = { ...facts(false), pendingVerification: true };
  await reconcileNativeTurn(ports, { ...at, ...older }, running);
  await reconcileNativeTurn(ports, { ...at, ...older }, facts(false));
  assert.deepEqual((await range()).pendingNativeCheck, older, 'a result without a terminal does not release the barrier');

  const update = ports.candidates.update;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let held = false;
  ports.candidates.update = async (mutate) => {
    if (!held) { held = true; entered.resolve(); await release.promise; }
    return update(mutate);
  };
  const late = reconcileNativeTurn(ports, { ...at, ...older }, running);
  await entered.promise;
  const newer = await open();
  assert.equal((await range()).pendingNativeCheck, undefined);
  release.resolve();
  await late;
  assert.equal((await range()).pendingNativeCheck, undefined);

  await update((pending) => ({ ...pending, [at.sessionId]: { ...pending[at.sessionId], pendingNativeCheck: older } }));
  await recoverNativeTurns(ports);
  assert.equal((await range()).pendingNativeCheck, undefined, 'recovery removes a stale barrier left by a killed worker');

  await reconcileNativeTurn(ports, { ...at, ...newer }, running);
  assert.deepEqual((await range()).pendingNativeCheck, newer);
  const unknown = facts();
  unknown.record.checks[0].failed = null;
  await reconcileNativeTurn(ports, { ...at, ...newer }, unknown);
  assert.equal((await range()).pendingNativeCheck, undefined, 'the terminal has no running background check');
  assert.deepEqual((await range()).turns.map(({ turn }) => turn), [1], 'unknown foreground work stays out of the range');
  await reconcileNativeTurn(ports, { ...at, ...newer }, facts());
  assert.equal((await range()).pendingNativeCheck, undefined);
  assert.deepEqual((await range()).turns.map(({ turn }) => turn), [1, newer.turn]);
});

for (const [stage, turn] of [['provisional', 1], ['provisional', 2], ['activated', 1]]) {
  test(`recovery cannot distill a previously ${stage} candidate with a pending check (current turn ${turn})`, async () => {
    const made = await pending({ gone: new Set([4242]) });
    const observed = facts();
    observed.record.checks.unshift({ command: 'npm run lint', failed: null });
    observed.pendingVerification = true;
    const candidate = legacyCandidate(observed.record, {
      sessionEpoch: made.sessions.get('session').sessionEpoch,
      now: made.ports.clock.now(), finalizationPending: stage === 'provisional' });
    await made.ports.candidates.update(() => ({ session: candidate }));
    await made.ports.sessions.update('session', stored => ({ ...stored, turn, open: false,
      native: { ...stored.native, turn, settled: true, pending: turn === 1, candidateMade: turn === 1 } }));
    made.ports.native.read = async () => ({ status: 'unreadable' });
    made.ports.model.complete = () => assert.fail('a pending check must not request a model');

    assert.equal((await distillSession(made.ports, { sessionId: 'session' })).status, 'busy');
    assert.deepEqual(await distillDue(made.ports), []);
    await recoverNativeTurns(made.ports);
    assert.deepEqual((await made.ports.candidates.read()).session, candidate);
    assert.deepEqual(await distillDue(made.ports), []);
    assert.equal(made.requests.some(({ path }) => path === '/conversation/distill'), false);

    if (turn === 1) {
      observed.record.checks[0].failed = false;
      observed.pendingVerification = false;
      made.ports.native.read = async () => observed;
      assert.equal((await recoverNativeTurns(made.ports))[0].waiting, false);
      const ready = (await made.ports.candidates.read()).session;
      assert.equal(ready.turns.length, 1);
      const work = ready.turns[0];
      assert.deepEqual(work.steps.filter(({ kind }) => kind === 'check'), observed.record.checks.map(check => ({ kind: 'check', ...check, exit: null })));
      assert.equal(work.finalizationPending, undefined);
    }
  });
}
