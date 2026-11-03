import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reconcileNativeTurn, recoverNativeTurns } from '../../lib/app/native-turn.js';
import { promptSubmitted } from '../../lib/app/prompt.js';
import { sessionStarted } from '../../lib/app/session-start.js';
import { sessionEnded } from '../../lib/app/session-end.js';
import { distillLeftovers, distillSession, dropExpiredLeftovers } from '../../lib/app/distill-session.js';
import { UNDISTILLED_LEFTOVER_TTL_MS } from '../../lib/distill/candidate.js';
import { memoryPorts, PROMPT } from './memory-ports.js';

const route = { alias: 'route-b', providerId: 'account-b', model: 'upstream-b', protocol: 'openai', endpoint: 'https://api.example/v1', effort: 'off', binding: 'captured-account', configRevision: 'same-config' };
const modelHint = { alias: 'route-b', effort: 'off' };
const payload = { session_id: 'native-session', cwd: '/workspace' };
const at = { sessionId: 'session', projectDir: '/workspace', payload, turn: 1 };
const record = () => ({ commands: ['npm test'], paths: ['/workspace/file.js'], edits: ['/workspace/file.js'], checks: [{ command: 'npm test', failed: false }], answer: 'Fixed retries.' });
const facts = (terminal = true) => ({ status: 'ok', schemaSupported: true, schemaVersion: '1.5', mark: { offset: 500, fileId: 'wire' }, modelHint,
  bind: { turnId: '0', promptId: 'native-prompt', origin: 'user', mark: 120 },
  terminal: terminal ? { turnId: '0', reason: 'completed', answer: 'Fixed retries.', modelHint: { ...modelHint, model: 'upstream-b', protocol: 'openai' } } : null,
  record: record() });

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
  await reconcileNativeTurn(made.ports, at, facts());
  assert.equal(made.queued.length, 1);
  assert.deepEqual(made.sessions.get('session').nativeCursor.mark, { offset: 500, fileId: 'wire' });
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

test('late background verification only rejudges its original still-last turn', async () => {
  const made = await pending();
  const running = facts(); running.record.checks[0].failed = null;
  assert.equal((await reconcileNativeTurn(made.ports, at, running)).waiting, true);
  assert.deepEqual(await made.ports.candidates.read(), {});
  await reconcileNativeTurn(made.ports, at, facts());
  assert.equal((await made.ports.candidates.read()).session.turn, 1);
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

test('an unresolved native model binding remains blocked without consuming attempts or expiring the verified candidate', async () => {
  for (const missingCapture of [true, false]) {
    const made = await pending({ gone: new Set([4242]) });
    const observed = facts();
    if (missingCapture) await made.ports.sessions.update('session', stored => ({ ...stored, native: { ...stored.native, model: null } }));
    else observed.terminal.modelHint.model = 'unmatched-native-model';
    made.ports.model.complete = () => assert.fail('an unresolved account must not request a model');
    await reconcileNativeTurn(made.ports, at, observed);
    for (let count = 0; count < 3; count++) {
      assert.deepEqual(await distillLeftovers(made.ports), [{ status: 'blocked', reason: 'route_unresolved' }]);
    }
    const candidate = (await made.ports.candidates.read()).session;
    assert.equal(candidate.attempts, 0);
    assert.equal(candidate.claimedBy, null);
    assert.deepEqual(candidate.blocked, { reason: 'route_unresolved' });
    made.advance(UNDISTILLED_LEFTOVER_TTL_MS + 1);
    await dropExpiredLeftovers(made.ports);
    assert.ok((await made.ports.candidates.read()).session);
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

test('a prompt or owner change during a native read cannot close a newer unbound turn', async () => {
  for (const change of [
    made => promptSubmitted(made.ports, { sessionId: 'session', prompt: 'New task.', waitMs: 500 }),
    made => made.ports.sessions.update('session', stored => ({ ...stored, pid: 9999 })),
  ]) {
    const made = await pending();
    made.ports.native.read = async () => { await change(made); return facts(); };
    await reconcileNativeTurn(made.ports, at);
    assert.equal(made.sessions.get('session').open, true);
    assert.deepEqual(await made.ports.candidates.read(), {});
    assert.deepEqual(made.queued, []);
  }
});

test('a duplicate terminal cannot recreate an explicitly discarded candidate', async () => {
  const made = await pending();
  await reconcileNativeTurn(made.ports, at, facts());
  await made.ports.candidates.update(() => ({}));
  await reconcileNativeTurn(made.ports, at, facts());
  assert.deepEqual(await made.ports.candidates.read(), {});
});

test('session end preserves a pending native turn and its original prompt for late task completion', async () => {
  const made = await pending();
  const running = facts(); running.record.checks[0].failed = null;
  await reconcileNativeTurn(made.ports, at, running);
  await sessionEnded(made.ports, at);
  assert.equal(made.sessions.get('session').native.pending, true);
  await reconcileNativeTurn(made.ports, at, facts());
  const candidate = (await made.ports.candidates.read()).session;
  assert.equal(candidate.prompt, PROMPT);
  assert.equal(candidate.closed, true);
  assert.equal(made.queued.length, 1);
});

test('a native finalization claim covers the candidate-consumed window before the settled marker is written', async () => {
  const made = await pending({ distillAnswer: { status: 'stored' } });
  let completions = 0;
  made.ports.model.complete = async () => { completions++; return { answer: JSON.stringify({ summary: 'Reusable retry method.', strategy: ['Validate retries.'] }) }; };
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

test('native candidates survive failed finalization writes without being consumed or recreated', async () => {
  for (const stage of ['marker', 'activation']) {
    const made = await pending({ distillAnswer: { status: 'stored' }, gone: new Set([4242]) });
    let completions = 0, failed = false;
    made.ports.model.complete = async () => { completions++; return { answer: JSON.stringify({ summary: 'Reusable retry method.', strategy: ['Validate retries.'] }) }; };
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
        if (!failed && pending.session?.finalizationPending === true && next?.session && next.session.finalizationPending !== true) {
          failed = true; throw Object.assign(new Error('candidate activation failed'), { code: 'EACCES' });
        }
        return next;
      });
    }
    await assert.rejects(reconcileNativeTurn(made.ports, at, facts()), { code: 'EACCES' });
    assert.equal((await made.ports.candidates.read()).session.finalizationPending, true);
    assert.equal((await distillSession(made.ports, { sessionId: 'session' })).status, 'busy');
    assert.deepEqual(await distillLeftovers(made.ports), []);
    made.advance(UNDISTILLED_LEFTOVER_TTL_MS + 1);
    await dropExpiredLeftovers(made.ports);
    assert.ok((await made.ports.candidates.read()).session, 'unfinished persistence must retain its candidate past expiry');
    assert.equal(completions, 0);
    made.ports.sessions.update = sessionUpdate; made.ports.candidates.update = candidateUpdate;
    await recoverNativeTurns(made.ports);
    assert.notEqual((await made.ports.candidates.read()).session.finalizationPending, true);
    assert.equal((await distillSession(made.ports, { sessionId: 'session' })).status, 'stored');
    await reconcileNativeTurn(made.ports, at, facts());
    assert.deepEqual(await made.ports.candidates.read(), {});
    assert.equal(completions, 1);
  }
});

test('a later prompt cannot strand an older pending candidate when activation needs recovery', async () => {
  const made = await pending({ distillAnswer: { status: 'stored' } });
  let completions = 0, held = false, failed = false;
  made.ports.model.complete = async () => { completions++; return { answer: JSON.stringify({ summary: 'Reusable retry method.', strategy: ['Validate retries.'] }) }; };
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
    if (!failed && pending.session?.finalizationPending === true && next?.session && next.session.finalizationPending !== true) {
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
  made.ports.model.complete = async () => ({ answer: JSON.stringify({ summary: 'Reusable retry method.', strategy: ['Validate retries.'] }) });
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), enqueue = made.ports.reports.enqueue;
  let held = false;
  made.ports.reports.enqueue = async entries => {
    if (!held) { held = true; entered.resolve(); await release.promise; }
    return enqueue(entries);
  };
  const first = reconcileNativeTurn(made.ports, at, facts());
  await entered.promise;
  await sessionEnded(made.ports, at);
  release.resolve(); await first;
  assert.equal(made.ports.owner.isGone(4242), false);
  assert.equal((await made.ports.candidates.read()).session.closed, true);
  assert.deepEqual((await distillLeftovers(made.ports)).map(outcome => outcome.status), ['stored']);
});

test('native claims refuse a live holder without TTL takeover and recover a dead stale holder', async () => {
  const gone = new Set(), made = await pending({ gone });
  await made.ports.sessions.update('session', stored => ({ ...stored, open: false, turnId: '0', settling: made.ports.clock.now(), native: { ...stored.native, turnId: '0', promptId: 'native-prompt', finalizingPid: 9999 } }));
  made.advance(60_000);
  await reconcileNativeTurn(made.ports, at, facts());
  assert.deepEqual(await made.ports.candidates.read(), {});
  gone.add(9999);
  await reconcileNativeTurn(made.ports, at, facts());
  assert.equal((await made.ports.candidates.read()).session.turn, 1);
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

test('an eligible turn with an earlier pending check cannot recreate its consumed candidate on later polls', async () => {
  const made = await pending({ distillAnswer: { status: 'stored' } });
  let completions = 0;
  made.ports.model.complete = async () => { completions++; return { answer: JSON.stringify({ summary: 'Reusable retry method.', strategy: ['Validate retries.'] }) }; };
  const observed = facts();
  observed.record.checks.unshift({ command: 'npm run lint', failed: null });
  assert.equal((await reconcileNativeTurn(made.ports, at, observed)).waiting, true);
  assert.equal((await distillSession(made.ports, { sessionId: 'session' })).status, 'stored');
  await reconcileNativeTurn(made.ports, at, observed);
  assert.deepEqual(await made.ports.candidates.read(), {});
  observed.record.checks[0].failed = false;
  assert.equal((await reconcileNativeTurn(made.ports, at, observed)).waiting, false);
  assert.deepEqual(await made.ports.candidates.read(), {});
  assert.equal(completions, 1);
});
