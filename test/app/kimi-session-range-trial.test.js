import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCommand } from '../../lib/app/commands/index.js';
import { distillDue, distillSession, dropExpiredLeftovers } from '../../lib/app/distill-session.js';
import { reconcileNativeTurn } from '../../lib/app/native-turn.js';
import { promptSubmitted } from '../../lib/app/prompt.js';
import { turnEnded } from '../../lib/app/turn-end.js';
import { rangeOf, withCorrection, withoutWorkTurn } from '../../lib/distill/range.js';
import { ModelUnavailable } from '../../lib/runtime/native-config.js';
import { memoryPorts, PROMPT } from './memory-ports.js';
import { changeTurn, DRAFTED, IR } from './work-turns.js';

const sessionId = 'session';
const route = { alias: 'route-a', providerId: 'account-a', model: 'model-a', protocol: 'openai', effort: 'off', binding: 'binding-a' };
const posts = ({ requests }) => requests.filter(({ path }) => path === '/conversation/distill');

test('Kimi cannot distill while an earlier background check is unresolved', async () => {
  let calls = 0;
  const made = memoryPorts({ distillAnswer: DRAFTED, model: { complete: async () => { calls++; return { answer: JSON.stringify(IR) }; } } });
  const { ports } = made;
  const projectDir = '/workspace';
  const payload = { session_id: 'native-session', cwd: projectDir };
  for (const turn of [1, 2, 3]) await changeTurn(ports, sessionId, turn, { model: route, projectDir });
  assert.equal(rangeOf(await ports.candidates.read(), sessionId).turns.length, 3);
  await promptSubmitted(ports, { sessionId, prompt: PROMPT, projectDir, waitMs: 500 });
  await ports.sessions.update(sessionId, (stored) => ({ ...stored, native: {
    turn: stored.turn, payload, mark: { offset: 100, fileId: 'wire' }, turnId: null, model: route,
  } }));
  const record = { commands: ['npm run lint', 'npm test'], checks: [
    { command: 'npm run lint', failed: null }, { command: 'npm test', failed: false },
  ], paths: ['/workspace/app.js'], edits: ['/workspace/app.js'], answer: 'Implemented and tested.' };
  const facts = { status: 'ok', schemaSupported: true, schemaVersion: '1.5', mark: { offset: 500, fileId: 'wire' },
    bind: { turnId: '0', promptId: 'prompt', origin: 'user', mark: 120 },
    terminal: { turnId: '0', reason: 'completed', answer: record.answer, modelHint: route }, record, pendingVerification: true };
  ports.native = { read: async () => facts };
  const observed = await reconcileNativeTurn(ports, { sessionId, projectDir, payload });
  assert.equal(observed.waiting, true);
  const outcome = await distillSession(ports, { sessionId });
  assert.deepEqual({ calls, posted: posts(made).length }, { calls: 0, posted: 0 }, outcome.status);
  await ports.candidates.update((pending) => ({ ...pending, [sessionId]: { ...pending[sessionId], closed: true } }));
  await distillDue(ports);
  assert.deepEqual({ calls, posted: posts(made).length }, { calls: 0, posted: 0 });
});

test('a stale finalizer cannot close a Kimi turn in a newer epoch with a reused native id', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId, prompt: PROMPT, turnId: '0', waitMs: 500 });
  const current = await ports.sessions.update(sessionId, (stored) => ({ ...stored, sessionEpoch: 'new-owner' }));
  await turnEnded(ports, { sessionId, turnId: '0', reason: 'answer', finalizationPending: true,
    expected: { turn: current.turn, pid: current.pid, sessionEpoch: 'old-owner' }, recordOf: () => ({
      commands: ['npm test'], paths: ['app.js'], edits: ['app.js'], checks: [{ command: 'npm test', failed: false }], answer: 'Old result.',
    }),
  });
  assert.equal((await ports.sessions.read(sessionId)).open, true);
  assert.deepEqual(await ports.candidates.read(), {});
});

test('an unavailable Kimi model route parks the range without consuming retry attempts', async () => {
  const { ports, advance } = memoryPorts({ model: { capture: async () => route, complete: async () => { throw new ModelUnavailable('route_changed'); } } });
  for (const turn of [1, 2, 3]) await changeTurn(ports, sessionId, turn, { model: route });
  await ports.candidates.update((pending) => ({ ...pending, [sessionId]: { ...pending[sessionId], closed: true } }));
  const outcomes = [];
  for (let run = 0; run < 3; run++) {
    outcomes.push(...await distillDue(ports));
    advance(60 * 60 * 1000);
  }
  const range = rangeOf(await ports.candidates.read(), sessionId);
  assert.deepEqual({ statuses: outcomes.map(({ status }) => status), attempts: range?.attempts }, { statuses: ['blocked'], attempts: 0 });
});

test('an imported Kimi range keeps its blocked-route TTL after its original candidate ages out', async () => {
  const day = 24 * 60 * 60 * 1000;
  const now = 10 * day;
  const { ports } = memoryPorts({ now });
  await ports.candidates.update(() => ({ [sessionId]: { at: now - 2 * day, blocked: { at: now - day / 2, reason: 'route_changed' },
    closed: true, model: route, turn: 1, prompt: PROMPT, checks: [{ command: 'npm test', failed: false }], paths: ['app.js'],
  } }));
  await dropExpiredLeftovers(ports);
  assert.equal(rangeOf(await ports.candidates.read(), sessionId)?.blocked?.reason, 'route_changed');
});

test('a correction during Kimi completion invalidates the IR before the Proxy receives it', async () => {
  const made = memoryPorts({ distillAnswer: DRAFTED, model: { complete: async () => {
    await made.ports.candidates.update((pending) => withCorrection(pending, sessionId, 1, 'That was wrong.', made.ports.clock.now()));
    return { answer: JSON.stringify(IR) };
  } } });
  await changeTurn(made.ports, sessionId, 1, { model: route });
  const outcome = await distillSession(made.ports, { sessionId });
  assert.deepEqual({ posted: posts(made).length, drafts: (await made.ports.drafts.read()).length }, { posted: 0, drafts: 0 }, outcome.status);
});

test('removing a rejudged work turn invalidates the issued range revision', async () => {
  const { ports } = memoryPorts();
  await changeTurn(ports, sessionId, 1, { model: route });
  await changeTurn(ports, sessionId, 2, { model: route });
  const before = rangeOf(await ports.candidates.read(), sessionId);
  await ports.candidates.update((pending) => withoutWorkTurn(pending, sessionId, 2));
  const after = rangeOf(await ports.candidates.read(), sessionId);
  assert.equal(after.turns.length, 1);
  assert.notEqual(after.changedAt, before.changedAt);
});

test('a Kimi range never sends an earlier binding’s work to a different account', async () => {
  let calls = 0;
  const made = memoryPorts({ model: { complete: async () => {
    calls++;
    return { answer: JSON.stringify(IR) };
  } } });
  const { ports } = made;
  await changeTurn(ports, sessionId, 1, { model: route, prompt: 'Earlier account fixture work' });
  const newerRoute = { ...route, providerId: 'account-b', binding: 'binding-b' };
  await changeTurn(ports, sessionId, 2, { model: newerRoute });
  await distillSession(ports, { sessionId });
  assert.equal(calls, 0);
  assert.equal(posts(made).length, 0);
});

test('a correction during the first Proxy reply drops the draft and stops the second IR', async () => {
  const irs = [IR, { ...IR, title: 'Second verified method' }];
  const made = memoryPorts({ distillAnswer: DRAFTED, model: { complete: async () => ({ answer: JSON.stringify(irs) }) } });
  const { ports } = made;
  await changeTurn(ports, sessionId, 1, { model: route });
  const request = ports.proxy.request;
  ports.proxy.request = async (method, path, body) => {
    const response = await request(method, path, body);
    if (path === '/conversation/distill' && posts(made).length === 1) {
      await promptSubmitted(ports, { sessionId, prompt: 'still failing', waitMs: 0 });
    }
    return response;
  };

  await distillSession(ports, { sessionId });
  assert.equal(posts(made).length, 1);
  assert.deepEqual(await ports.drafts.read(), []);
  assert.equal(rangeOf(await ports.candidates.read(), sessionId).turns[0].correction, 'still failing');
});

test('a correction marker for any source turn prevents publishing a lingering range draft', async () => {
  const answer = { ...DRAFTED, publishable: true, publish_receipt: { receiptId: 'fixture' } };
  const made = memoryPorts({ distillAnswer: answer, model: { complete: async () => ({ answer: JSON.stringify(IR) }) } });
  const { ports } = made;
  await changeTurn(ports, sessionId, 1, { model: route });
  await changeTurn(ports, sessionId, 2, { model: route });
  const first = rangeOf(await ports.candidates.read(), sessionId).turns[0];
  assert.equal((await distillSession(ports, { sessionId })).status, 'drafted');
  await ports.draftCorrections.mark(sessionId, first.turn, first.sessionEpoch);

  const result = await runCommand(ports, { sessionId, name: 'evolver-drafts', args: 'publish 1' });
  assert.equal(result.ok, false);
  assert.match(result.text, /invalidated by a correction/i);
  assert.equal(made.requests.some(({ path }) => path === '/asset/submit' || path === '/asset/reverify'), false);
  assert.equal((await ports.drafts.read()).length, 1);
});

test('a correction removes only provisional work left before a native finalization could commit', async () => {
  const { ports } = memoryPorts();
  await changeTurn(ports, sessionId, 1, { model: route });
  await changeTurn(ports, sessionId, 2, { model: route });
  await ports.candidates.update((pending) => {
    const range = rangeOf(pending, sessionId);
    return { ...pending, [sessionId]: { ...range, turns: [range.turns[0], { ...range.turns[1], finalizationPending: true }] } };
  });
  await promptSubmitted(ports, { sessionId, prompt: 'still failing', waitMs: 0 });
  assert.deepEqual(rangeOf(await ports.candidates.read(), sessionId).turns.map(({ turn }) => turn), [1]);
});
