import assert from 'node:assert/strict';
import { test } from 'node:test';

import { draftNamed, draftOf, draftsListText, skipReasonOf, submitRequestOf, withDraft, withoutDraft } from '../lib/distill.js';
import { baseFor, isCurrentRange, settledRange, withClosedRange, withCorrection, withoutExpiredLeftovers, withoutWorkTurn, withWorkTurn } from '../lib/distill/range.js';
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

test('session cleanup closes only the range it observed, including legacy session epochs', () => {
  const read = { at: 1_000, sessionEpoch: 1, turns: [{ turn: 1, prompt: 'p', steps: [], answer: '', at: 1_000 }] };
  assert.equal(withClosedRange({ s: read }, 's', read).s.closed, true);
  for (const replacement of [
    { ...read, at: 2_000 },
    { ...read, sessionEpoch: 2 },
    { ...read, turns: [{ ...read.turns[0], turn: 2 }] },
  ]) {
    assert.equal(withClosedRange({ s: replacement }, 's', read), undefined);
  }
  assert.equal(withClosedRange({ s: read }, 's', null), undefined);
  const { sessionEpoch, ...legacy } = read;
  assert.equal(withClosedRange({ s: legacy }, 's', legacy).s.closed, true);
});

test('session cleanup includes a late final turn but excludes resumed work even when old turns overlap', () => {
  const first = { turn: 1, prompt: 'p', steps: [], answer: '', at: 1_000 };
  const final = { at: 1_000, sessionEpoch: 1, turns: [first] };
  const ending = { turn: 1, sessionEpoch: 1 };
  assert.equal(withClosedRange({ s: final }, 's', null, ending).s.closed, true);
  const consumed = { ...final, turns: [{ ...first, turn: 0 }] };
  assert.equal(withClosedRange({ s: { ...final, at: 2_000 } }, 's', consumed, ending).s.closed, true);
  for (const replacement of [
    { ...final, sessionEpoch: 2 },
    { ...final, turns: [{ ...first, turn: 2 }] },
    { ...final, turns: [first, { ...first, turn: 2 }] },
  ]) {
    assert.equal(withClosedRange({ s: replacement }, 's', null, ending), undefined);
    assert.equal(withClosedRange({ s: replacement }, 's', final, ending), undefined);
  }
  const resumed = withWorkTurn({ s: { ...final, closed: true } }, 's', { ...first, turn: 2 }, { now: 2_000, sessionEpoch: 1 });
  assert.equal(resumed.s.closed, true, 'resuming an already closed range preserves its existing due state');
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

test('a late turn, removal or correction of an older session epoch leaves the newer epoch\'s range alone', () => {
  const turn = (number) => ({ turn: number, prompt: 'p', steps: [], answer: '', at: number });
  const newer = { s: { at: 20, changedAt: 20, sessionEpoch: 20, turns: [turn(1)] } };
  assert.equal(withWorkTurn(newer, 's', turn(1), { now: 30, sessionEpoch: 10 }), undefined);
  assert.equal(withCorrection(newer, 's', 1, 'no, still failing', 30, { sessionEpoch: 10 }), undefined);
  assert.equal(withoutWorkTurn(newer, 's', 1, { sessionEpoch: 10 }), undefined);
  assert.equal(withWorkTurn(newer, 's', turn(1), { now: 30, sessionEpoch: 40 }).s.sessionEpoch, 40);
  assert.equal(withCorrection(newer, 's', 1, 'no, still failing', 30, { sessionEpoch: 20 }).s.turns[0].correction, 'no, still failing');
});

test('a turn judged again after a later one joined keeps the range\'s newer route, snapshot and block', () => {
  const turn = (number) => ({ turn: number, prompt: 'p', steps: [], answer: '', at: number });
  const newer = { root: '/repo', head: 'h2', diff: 'newer diff' };
  const range = { at: 1, changedAt: 2, sessionEpoch: 1, model: 'route-b', project: newer, pid: 2, blocked: { reason: 'route_changed', at: 2 }, turns: [turn(1), turn(2)] };
  const { s } = withWorkTurn({ s: range }, 's', { ...turn(1), answer: 'judged again' }, {
    now: 3, sessionEpoch: 1, model: 'route-a', project: { root: '/repo', head: 'h1', diff: 'older diff' }, pid: 1,
  });
  assert.deepEqual([s.model, s.project, s.pid, s.blocked], ['route-b', newer, 2, range.blocked]);
  assert.equal(s.turns.find(({ turn }) => turn === 1).answer, 'judged again');
});

test('a turn of another session epoch takes its diff from its own HEAD, not the old range\'s base', () => {
  const range = { at: 1, sessionEpoch: 10, base: { root: '/repo', head: 'old' }, turns: [{ turn: 1, head: { root: '/repo', head: 'old' } }] };
  const workTurn = { turn: 1, head: { root: '/repo', head: 'new' } };
  assert.deepEqual(baseFor({ s: range }, 's', workTurn, { sessionEpoch: 20 }), workTurn.head);
  assert.deepEqual(baseFor({ s: range }, 's', workTurn, { sessionEpoch: 10 }), range.base);
});
