import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DRAFTS_TTL_MS, distillPromptOf, distillRequestOf, draftNamed, draftOf, draftsListText, isDistillableTurn, lessonOf, skipReasonOf,
  submitRequestOf, withDraft, withoutDraft,
} from '../lib/distill.js';

const LESSON = {
  reusable: true,
  title: 'Retry uploads with capped backoff',
  summary: 'Uploads that time out under load succeed once retried with jittered, capped exponential backoff.',
  strategy: ['Measure the failure rate', 'Retry with jittered exponential backoff', 'Cap the retries and alert'],
  signals: ['timeout'],
};

test('only an answered person turn that edited and ended on a passing check is distillable', () => {
  const turn = { reason: 'answer', agentId: undefined, isPersonTurn: true, changedLines: 3, checks: [{ command: 'npm test', failed: false }] };
  assert.equal(isDistillableTurn(turn), true);
  assert.equal(isDistillableTurn({ ...turn, reason: 'aborted' }), false);
  assert.equal(isDistillableTurn({ ...turn, agentId: 'a1' }), false);
  assert.equal(isDistillableTurn({ ...turn, isPersonTurn: false }), false);
  assert.equal(isDistillableTurn({ ...turn, changedLines: 0 }), false);
  assert.equal(isDistillableTurn({ ...turn, checks: [] }), false);
  assert.equal(isDistillableTurn({ ...turn, checks: [{ command: 'npm test', failed: false }, { command: 'tsc', failed: true }] }), false);
});

test('the prompt asks for JSON only and carries a redacted focus', () => {
  assert.doesNotMatch(distillPromptOf(), /Focus on/);
  const prompt = distillPromptOf('the retry with token=abcdef123456');
  assert.match(prompt, /Answer with one JSON object and nothing else/);
  assert.match(prompt, /Focus on: the retry with \[redacted\]$/);
});

test('a complete lesson is read out of surrounding text', () => {
  assert.deepEqual(lessonOf(`Here it is:\n${JSON.stringify(LESSON)}\n`), {
    title: LESSON.title, summary: LESSON.summary, strategy: LESSON.strategy, signals: LESSON.signals,
  });
});

test('incomplete, unreusable, unparseable or secret-bearing lessons are dropped', () => {
  assert.equal(lessonOf('{"reusable": false}'), null);
  assert.equal(lessonOf('not json'), null);
  assert.equal(lessonOf(JSON.stringify({ ...LESSON, strategy: LESSON.strategy.slice(0, 2) })), null);
  assert.equal(lessonOf(JSON.stringify({ ...LESSON, summary: 'too short' })), null);
  assert.equal(lessonOf(JSON.stringify({ ...LESSON, title: '' })), null);
  assert.equal(lessonOf(JSON.stringify({ ...LESSON, strategy: [...LESSON.strategy, 'export API_KEY=sk-ant-0123456789abcdefghij'] })), null);
});

test('the request keeps each check once, as its last run, only project-relative artifacts, and the caller\'s host', () => {
  const { method, path, body } = distillRequestOf({
    lesson: lessonOf(JSON.stringify(LESSON)),
    checks: [{ command: 'npm test', failed: true }, { command: 'tsc', failed: false }, { command: 'npm test', failed: false }],
    paths: ['/repo/src/upload.js', '/repo/src/upload.js', '/etc/hosts', 'src/retry.js'],
    projectDir: '/repo',
    sessionId: 'codex:s1',
    platform: 'codex',
  });
  assert.equal(method, 'POST');
  assert.equal(path, '/conversation/distill');
  assert.deepEqual(body.execution.trace, [{ command: 'tsc', exit: 0 }, { command: 'npm test', exit: 0 }]);
  assert.deepEqual(body.validation, ['tsc', 'npm test']);
  assert.deepEqual(body.artifacts, ['src/upload.js', 'src/retry.js']);
  assert.equal(body.persist, false);
  assert.equal(body.publish, false);
  assert.equal(body.session_id, 'codex:s1');
  assert.equal(body.platform, 'codex', 'the host is the caller\'s, never assumed');
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

test('drafts are deduplicated by id, capped, and expire', () => {
  const draft = (id, createdAt = 0) => ({ id, title: id, summary: '', assets: [], createdAt });
  const once = withDraft(withDraft([], draft('a'), 0), draft('a', 1), 1);
  assert.deepEqual(once.map((d) => d.createdAt), [1]);
  const many = Array.from({ length: 25 }, (_, i) => draft(`d${i}`)).reduce((list, d) => withDraft(list, d, 0), []);
  assert.equal(many.length, 20);
  assert.equal(many[0].id, 'd5');
  assert.deepEqual(withDraft([draft('old')], draft('new', DRAFTS_TTL_MS + 1), DRAFTS_TTL_MS + 1).map((d) => d.id), ['new']);
  assert.deepEqual(withoutDraft([draft('a'), draft('b')], 'a', 0).map((d) => d.id), ['b']);
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
