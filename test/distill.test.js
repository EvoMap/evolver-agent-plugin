import assert from 'node:assert/strict';
import { test } from 'node:test';

import { draftNamed, draftOf, draftsListText, skipReasonOf, submitRequestOf, withDraft, withoutDraft } from '../lib/distill.js';
import { isCurrentRange, settledRange, withoutExpiredLeftovers, withoutWorkTurn } from '../lib/distill/range.js';
import { corpusEntryOf } from '../lib/distill/corpus.js';

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

test('cleaning up an empty or missing range table changes nothing', () => {
  for (const pending of [undefined, null, {}]) assert.equal(withoutExpiredLeftovers(pending, { now: 1, isGone: () => false }), undefined);
});

test('a work turn\'s stored route binding never reaches the calibration corpus', () => {
  const turn = { turn: 1, prompt: 'p', steps: [], answer: 'a', at: 1, modelBinding: 'a'.repeat(64) };
  const entry = corpusEntryOf({
    platform: 'kimi', sessionId: 's', trigger: 'idle', range: { turns: [turn] },
    gate: { passed: true, reason: null, workTurns: 1, episodes: 1 }, kind: 'fix', session: { record: [], userPrompt: '', finalAnswer: '' }, now: 2,
  });
  assert.equal(JSON.stringify(entry).includes('modelBinding'), false);
});
