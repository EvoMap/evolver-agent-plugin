import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isOlderThan, noticeDecision, pendingClaimUrl, upgradeNoticeText, versionOf, versionProbeArgv } from '../lib/onboarding.js';
import { proxyResultOf, proxySettingsFrom } from '../lib/proxy-response.js';
import { outcomeOfReason } from '../lib/turn-outcomes.js';

test('each way a Claude Code turn can end has an outcome, and nothing else does', () => {
  assert.equal(outcomeOfReason('answer'), 'success');
  assert.equal(outcomeOfReason('aborted'), 'failed');
  assert.equal(outcomeOfReason('refusal'), 'failed');
  assert.equal(outcomeOfReason('error'), 'failed');
  assert.equal(outcomeOfReason('completed'), null);
});

test('Proxy settings honour a loopback URL and token, and ignore any other host', () => {
  const settings = JSON.stringify({ proxy: { url: 'http://127.0.0.1:4555/', token: 't' } });
  assert.deepEqual(proxySettingsFrom(settings, '19820'), { url: 'http://127.0.0.1:4555', token: 't' });

  const remote = JSON.stringify({ proxy: { url: 'https://evil.example', token: 't' } });
  assert.equal(proxySettingsFrom(remote, '19820').url, 'http://127.0.0.1:19820');
  assert.deepEqual(proxySettingsFrom('not json', ''), { url: 'http://127.0.0.1:19820', token: null });
});

test('a Proxy response becomes data on success and an actionable error otherwise', () => {
  assert.deepEqual(proxyResultOf({ ok: true, status: 200, text: '{"a":1}' }, 'b', null), { ok: true, data: { a: 1 } });
  const rejected = proxyResultOf({ ok: false, status: 401, text: '{}' }, 'http://127.0.0.1:1', 'tok');
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /token .* was rejected/);
});

test('only an older Evolver gets the upgrade notice', () => {
  assert.equal(versionOf('evolver v2.0.38\n'), '2.0.38');
  assert.ok(isOlderThan('2.0.38', '2.0.39'));
  assert.match(upgradeNoticeText('2.0.38'), /2\.0\.39/);
  assert.equal(upgradeNoticeText('2.1.0'), null);
  assert.equal(upgradeNoticeText(null), null);
});

test('only an https evomap.ai claim link is trusted', () => {
  assert.equal(pendingClaimUrl(' https://evomap.ai/claim/abc \n'), 'https://evomap.ai/claim/abc');
  assert.equal(pendingClaimUrl('http://evomap.ai/claim/abc'), null);
  assert.equal(pendingClaimUrl('https://evomap.ai.evil.example/claim'), null);
});

test('a throttled notice is due once per ttl', () => {
  const first = noticeDecision({}, 'k', 1000, 5000);
  assert.equal(first.isDue, true);
  assert.equal(noticeDecision(first.state, 'k', 1000, 5500).isDue, false);
  assert.equal(noticeDecision(first.state, 'k', 1000, 6001).isDue, true);
});

test('only prompts the person sent are recalled for', async () => {
  const { isPersonPrompt } = await import('../lib/recall.js');
  for (const kind of ['composer', 'bridge', 'sdk', 'scheduled-trigger']) assert.equal(isPersonPrompt({ kind }), true, kind);
  for (const kind of ['task-notification', 'peer', 'plugin', 'channel', 'auto-continuation', 'unclassified']) {
    assert.equal(isPersonPrompt({ kind }), false, kind);
  }
  assert.equal(isPersonPrompt(undefined), true);
});

test('the evolver version probe goes through cmd.exe on Windows, where the CLI is a .cmd shim', () => {
  assert.deepEqual(versionProbeArgv(false), ['evolver', '--version']);
  assert.deepEqual(versionProbeArgv(true), ['cmd.exe', '/d', '/s', '/c', 'evolver --version']);
});
