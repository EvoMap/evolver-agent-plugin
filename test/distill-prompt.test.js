import assert from 'node:assert/strict';
import { test } from 'node:test';

import { irPromptOf } from '../lib/distill/ir-prompt.js';
import { defaultKindOf } from '../lib/distill/kinds.js';
import { sessionRecordOf } from '../lib/distill/record.js';
import { distillBodiesOf, reusedAssetIdsOf } from '../lib/distill/request.js';
import { workTurnOf } from '../lib/distill/work-turn.js';

const rangeOf = (records, source = 'observed') => ({
  turns: records.map((record, index) => workTurnOf({ turn: index + 1, prompt: 'Fix the client', record: { commands: [], edits: [], answer: 'Fixed.', ...record }, answer: 'Fixed.', now: 1 })),
  source,
});

const bodyOf = (range) => distillBodiesOf({ platform: 'codex', sessionId: 's1', trigger: 'idle', session: sessionRecordOf(range), irs: [{ title: 'T' }] })[0];

test('a check run with credentials on its command line goes in the trace and the record without them', () => {
  const checks = [
    { command: 'curl -u sentinel-user:CANARY_SECRET https://internal.example.test', exit: 0, failed: false },
    { command: 'npm test -- --token CANARY_TOKEN_1', exit: 0, failed: false },
    { command: "curl -u 'sentinel-user:CANARY_QUOTED' -H 'Authorization: Bearer CANARY_BEARER' https://internal.example.test", exit: 0, failed: false },
    { command: 'npm test -- --password "CANARY PASS"', exit: 0, failed: false },
    { command: "env PASSWORD='abc CANARY_SPACED' npm test", exit: 0, failed: false },
    { command: `curl -H 'Authorization: Digest username="u", response="CANARY_DIGEST"' -H 'Proxy-Authorization: Basic CANARYb' https://x.test`, exit: 0, failed: false },
  ];
  const body = bodyOf(rangeOf([{ checks }]));
  assert.doesNotMatch(JSON.stringify(body), /CANARY/);
  assert.deepEqual(body.execution.trace.map(({ command }) => command), ['curl -u [redacted] https://internal.example.test', 'npm test -- --token [redacted]',
    "curl -u [redacted] -H '[redacted]' https://internal.example.test", 'npm test -- --password [redacted]', 'env [redacted] npm test',
    "curl -H '[redacted]' -H '[redacted]' https://x.test"]);
});

test('a check of unknown result is a plain command in the record and supplies no trace row or made-up exit code', () => {
  const body = bodyOf(rangeOf([{ checks: [{ command: 'npm run lint', exit: null, failed: null }, { command: 'npm test', exit: null, failed: false }] }], 'reported'));
  assert.deepEqual(body.record.filter(({ kind }) => kind === 'command' || kind === 'check'), [{ kind: 'command', text: 'npm run lint' }, { kind: 'check', text: 'npm test' }]);
  assert.deepEqual(body.execution.trace, [{ command: 'npm test', ok: true, source: 'reported' }]);
  assert.match(irPromptOf({ record: body.record, kind: 'change' }), /\nR4 check \(passed, no exit code\): npm test\n/);
});

test('the kind a session defaults to is decided from its record alone', () => {
  const check = (failed) => ({ kind: 'check', command: 'npm test', exit: failed ? 1 : 0, failed });
  const edit = (path) => ({ kind: 'edit', path });
  const rows = [
    ['a check failed, files were edited, it passed', [check(true), edit('src/a.js'), check(false)], 'fix'],
    ['source edited, no error fixed', [edit('src/a.js'), check(false)], 'change'],
    ['nothing edited', [{ kind: 'command', command: 'git log' }, check(false)], 'investigate'],
    ['only manifest, config and CI files edited', [edit('package.json'), edit('.github/workflows/ci.yml'), edit('vite.config.ts'), check(false)], 'configure'],
  ];
  for (const [name, steps, kind] of rows) assert.equal(defaultKindOf([{ turn: 1, steps }]), kind, name);
});

const settingsDiffOf = (content) => `diff --git a/settings.json b/settings.json\n${content.split('\n').map((line) => `+${line}`).join('\n')}\n`;
const withSnapshot = (diff) => ({ ...rangeOf([{ checks: [] }]), project: { root: '/project', head: 'abc123', diff } });

test('the Proxy body rechecks a saved snapshot with the current secret filter and leaves out one holding a credential, without changing what was saved', () => {
  for (const [name, content] of [
    ['a quoted JSON credential', '{"accessToken":"opaque-example-123456789"}'],
    ['a credential object', '{"token":{"value":"opaqueFixtureObject"}}'],
    ['a credential array', '{"refreshToken":["opaqueFixtureArray"]}'],
    ['a credential nested multiline value', JSON.stringify({ token: { values: [
      { value: 'opaqueFixtureNested', closing: '} ]', quoted: 'escaped "quote" and { [' },
      ['ordinary', { closing: '] }' }],
    ] } }, null, 2)],
  ]) {
    const range = withSnapshot(settingsDiffOf(content));
    const saved = range.project.diff;
    const body = bodyOf(range);
    assert.deepEqual(body.project, { diff_omitted: 'secret' }, name);
    assert.doesNotMatch(JSON.stringify(body), /opaque-example|opaqueFixture/, name);
    assert.equal(range.project.diff, saved, name);
  }
});

test('the Proxy body keeps a clean saved snapshot as it was saved: an empty diff, and business keys with scalar, object and array values', () => {
  for (const diff of ['', ...['orders.id', { columns: ['orders.id'], closing: '} ]' }, ['orders.id', { column: 'tenant.id' }]].map((primaryKey) => settingsDiffOf(JSON.stringify({ primaryKey })))]) {
    const range = withSnapshot(diff);
    assert.deepEqual(bodyOf(range).project, range.project, diff);
  }
});

const assetId = (digit) => `sha256:${String(digit).repeat(64)}`;
const injectedAt = (turn, at = turn) => ({ turn, injectedAt: at, strategyText: '' });

test('the reused assets of a range are those injected into its turns, valid ids only, in injection order, at most 20', () => {
  const range = { sessionEpoch: 7, turns: [{ turn: 2 }, { turn: 3, sessionEpoch: 7 }] };
  const injected = {
    [assetId(3)]: injectedAt(3, 30),
    [assetId(1)]: injectedAt(1),
    [assetId(2)]: injectedAt(2),
    [assetId(4)]: injectedAt(3, 20),
    'sha256:step1': injectedAt(2),
    [`sha256:${'A'.repeat(64)}`]: injectedAt(2),
    [assetId(5)]: { turn: '2', injectedAt: 1 },
  };
  assert.deepEqual(reusedAssetIdsOf({ injected, sessionEpoch: 7 }, range), [assetId(2), assetId(4), assetId(3)]);

  const many = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`sha256:${index.toString(16).padStart(64, '0')}`, injectedAt(2, 100 - index)]));
  const kept = reusedAssetIdsOf({ injected: many, sessionEpoch: 7 }, range);
  assert.equal(kept.length, 20);
  assert.equal(kept[0], `sha256:${(24).toString(16).padStart(64, '0')}`, 'the earliest injections are kept');
});

test('a turn of another session epoch reused nothing this session file booked', () => {
  const injected = { [assetId(1)]: injectedAt(1) };
  assert.deepEqual(reusedAssetIdsOf({ injected, sessionEpoch: 9 }, { sessionEpoch: 7, turns: [{ turn: 1 }] }), []);
  assert.deepEqual(reusedAssetIdsOf({ injected, sessionEpoch: 9 }, { sessionEpoch: 7, turns: [{ turn: 1, sessionEpoch: 9 }] }), [assetId(1)]);
  assert.deepEqual(reusedAssetIdsOf({ injected }, { sessionEpoch: 7, turns: [{ turn: 1 }] }), [assetId(1)], 'a ledger from before epochs');
  assert.deepEqual(reusedAssetIdsOf({}, { turns: [{ turn: 1 }] }), []);
});

test('a body carries reused_asset_ids only when there are some, on every IR', () => {
  const session = sessionRecordOf(rangeOf([{ checks: [{ command: 'npm test', exit: 0, failed: false }] }]));
  const bodies = (reusedAssetIds) => distillBodiesOf({ platform: 'codex', sessionId: 's1', trigger: 'idle', session, irs: [{ title: 'A' }, { title: 'B' }], reusedAssetIds });
  assert.deepEqual(bodies([assetId(1)]).map((body) => body.reused_asset_ids), [[assetId(1)], [assetId(1)]]);
  assert.equal('reused_asset_ids' in bodies([])[0], false);
  assert.equal('reused_asset_ids' in bodies(undefined)[0], false);
});
