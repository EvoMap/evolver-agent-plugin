import assert from 'node:assert/strict';
import { test } from 'node:test';

import { draftNamed, draftOf, draftsListText, skipReasonOf, submitRequestOf, withDraft, withoutDraft } from '../lib/distill.js';
import { claimedOwn, hasDueRange, isCurrentRange, rangeRouteProblem, settledRange, withoutWorkTurn, withWorkTurn } from '../lib/distill/range.js';

test('settling what a distillation read cannot touch a range made at the same time or in another session epoch', () => {
  const turn = (number) => ({ turn: number, prompt: 'p', steps: [], answer: '', at: 1_000 });
  const read = { at: 1_000, sessionEpoch: 1, turns: [turn(1)] };
  const rows = [
    ['after its turns were distilled', { ...read, turns: [turn(2)] }],
    ['after the session started over', { ...read, sessionEpoch: 2 }],
  ];
  for (const [name, current] of rows) {
    assert.equal(isCurrentRange({ s: current }, 's', read), false, name);
    assert.equal(settledRange({ s: current }, 's', read, { consume: true, now: 2_000 }), undefined, name);
    assert.equal(isCurrentRange({ s: current }, 's', current), true, name);
  }
});

test('a delayed turn outside the retained window leaves the verified range intact', () => {
  const turn = (number, modelBinding) => ({ turn: number, at: number, sessionEpoch: 1, modelBinding, steps: [] });
  const base = { root: '/repo', head: 'new' };
  const range = { at: 2, sessionEpoch: 1, native: true, base, project: { ...base, diff: 'verified diff' },
    model: { binding: 'new' }, turns: Array.from({ length: 20 }, (_, index) => turn(index + 2, 'new')) };
  const delayed = { ...turn(1, 'old'), head: { root: '/repo', head: 'old' } };
  assert.equal(withWorkTurn({ s: range }, 's', delayed, {
    now: 22, native: true, sessionEpoch: 1, model: { binding: 'old' }, beforeNewerTurn: true,
  }), undefined);
});

test('settling an old blocked claim does not park a range whose conflicting turn was removed', () => {
  const turn = (number, modelBinding) => ({ turn: number, at: number, sessionEpoch: 1, modelBinding, steps: [] });
  const pending = { s: { at: 1, sessionEpoch: 1, native: true, closed: true, model: { binding: 'new' },
    turns: [turn(1, 'old'), turn(2, 'new')], routeConflict: 'route_changed', blocked: { reason: 'route_changed', at: 2 } } };
  const context = { pid: 42, isGone: () => false, now: 3 };
  const { next, claimed } = claimedOwn(pending, 's', context);
  const recovered = withoutWorkTurn(next, 's', 1, { now: 4 });
  const settled = settledRange(recovered, 's', claimed.range, { blocked: 'route_changed', now: 5 });
  assert.equal(hasDueRange(settled, { ...context, now: 5 }), true);
});

test('rolling out the conflicting turn does not unblock a Kimi range', () => {
  const turn = (number, modelBinding) => ({ turn: number, at: number, sessionEpoch: 1, modelBinding, steps: [] });
  const model = { binding: 'new' };
  const pending = { s: { at: 1, sessionEpoch: 1, native: true, model,
    turns: [turn(1, 'old'), ...Array.from({ length: 19 }, (_, index) => turn(index + 2, 'new'))],
    routeConflict: 'route_changed', blocked: { reason: 'route_changed', at: 2 } } };
  const stillMixed = withoutWorkTurn(pending, 's', 2);
  assert.equal(rangeRouteProblem(stillMixed.s), 'route_changed');

  const rolled = withWorkTurn(pending, 's', turn(21, 'new'), { now: 21, model, sessionEpoch: 1, native: true });
  assert.equal(rolled.s.turns[0].turn, 2);
  assert.equal(rangeRouteProblem(rolled.s), 'route_changed');
  assert.equal(rangeRouteProblem(withoutWorkTurn(rolled, 's', 2).s), 'route_changed');
});

const RESULT = {
  ok: true,
  distill_id: 'abc123',
  quality: { ok: true, score: 6 },
  signals: ['timeout'],
  gene: { asset_id: 'sha256:g', summary: 'gene summary' },
  capsule: { asset_id: 'sha256:c', summary: 'capsule summary' },
};

test('a draft needs a passing quality gate and both assets', () => {
  const draft = draftOf(RESULT, { title: 'T', sessionId: 's1' }, 5);
  assert.deepEqual({ ...draft, assets: draft.assets.length }, {
    id: 'abc123', title: 'T', summary: 'capsule summary', signals: ['timeout'], score: 6, assets: 2, sessionId: 's1', createdAt: 5,
  });
  assert.equal(draftOf({ ...RESULT, quality: { ok: false, reason: 'insufficient_reusable_signal' } }, {}, 0), null);
  assert.equal(draftOf({ ...RESULT, capsule: {} }, {}, 0), null);
  assert.equal(skipReasonOf({ ok: false, reason: 'summary_required' }), 'summary_required');
  assert.equal(skipReasonOf({ ok: true, quality: { ok: false, reason: 'insufficient_reusable_signal' } }), 'insufficient_reusable_signal');
});

test('drafts are deduplicated by id and retained until explicitly removed', () => {
  const draft = (id, createdAt = 0) => ({ id, title: id, summary: '', assets: [], createdAt });
  const once = withDraft(withDraft([], draft('a')), draft('a', 1));
  assert.deepEqual(once.map((d) => d.createdAt), [1]);
  const many = Array.from({ length: 25 }, (_, i) => draft(`d${i}`)).reduce((list, d) => withDraft(list, d), []);
  assert.equal(many.length, 25);
  assert.equal(many[0].id, 'd0');
  const later = 9 * 24 * 60 * 60 * 1000;
  assert.deepEqual(withDraft([draft('old')], draft('new', later)).map((d) => d.id), ['old', 'new']);
  assert.deepEqual(withoutDraft([draft('a'), draft('b')], 'a').map((d) => d.id), ['b']);
});

test('a draft is named by its list number or a unique id prefix', () => {
  const drafts = [{ id: 'aa11' }, { id: 'aa22' }, { id: 'bb33' }];
  assert.equal(draftNamed(drafts, '2').id, 'aa22');
  assert.equal(draftNamed(drafts, 'bb').id, 'bb33');
  assert.equal(draftNamed(drafts, 'aa'), null);
  assert.equal(draftNamed(drafts, '9'), null);
  assert.equal(draftNamed(drafts, ''), null);
});

test('publishing submits the bundle under a stable request id', () => {
  const request = submitRequestOf({ id: 'abc123', assets: [{ type: 'Gene' }, { type: 'Capsule' }] });
  assert.deepEqual(request, {
    method: 'POST', path: '/asset/submit', body: { assets: [{ type: 'Gene' }, { type: 'Capsule' }], request_id: 'evolver-agent-plugin.draft.abc123' },
  });
  assert.match(request.body.request_id, /^[A-Za-z0-9._:-]{1,128}$/);
});

test('the list says how to publish or discard', () => {
  assert.equal(draftsListText([]), 'No distilled drafts are waiting.');
  assert.match(draftsListText([{ id: 'abcdef1234567890', title: 'T', summary: 'S' }]), /1\. T \(abcdef123456\) — S\n.*publish <number>.*discard <number>/);
});

test('a turn judged again out of a host-model range keeps the range\'s model, base and snapshot', () => {
  const turn = (number) => ({ turn: number, prompt: 'p', steps: [], answer: '', at: number, head: { root: '/repo', head: `h${number}` } });
  const base = { root: '/repo', head: 'h1' };
  const range = { at: 1, sessionEpoch: 1, base, project: { ...base, diff: 'd' }, model: 'model-x', turns: [turn(1), turn(2)] };
  for (const removed of [1, 2]) {
    const { s } = withoutWorkTurn({ s: range }, 's', removed);
    assert.deepEqual([s.model, s.base, s.project, s.turns.map(({ turn }) => turn)], ['model-x', base, range.project, [3 - removed]]);
  }
});

test('a range claimed again by another process is no longer the one a distillation read', () => {
  const read = { at: 1, changedAt: 1, sessionEpoch: 1, claimedBy: 10, turns: [{ turn: 1, prompt: 'p', steps: [], answer: '', at: 1 }] };
  assert.equal(isCurrentRange({ s: read }, 's', read), true);
  assert.equal(isCurrentRange({ s: { ...read, claimedBy: 11 } }, 's', read), false);
});
