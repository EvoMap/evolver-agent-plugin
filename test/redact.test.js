import assert from 'node:assert/strict';
import { test } from 'node:test';

import { candidateOf } from '../lib/distill/candidate.js';
import { distillBody, distillPrompt } from '../lib/distill/prompt.js';
import { containsSecret, withoutSecrets } from '../lib/redact.js';

test('redaction removes the complete JSON string and leaves unrelated fields', () => {
  const text = JSON.stringify({ API_KEY: 'fixture "quoted" \\ tail', DEPLOY_KEY: 'fixture deploy', token: 'short', topic: 'retry' });
  assert.equal(containsSecret(text), true);
  assert.deepEqual(JSON.parse(withoutSecrets(text)), { API_KEY: '[redacted]', DEPLOY_KEY: '[redacted]', token: '[redacted]', topic: 'retry' });
  assert.equal(containsSecret(withoutSecrets(text)), false);
  assert.equal(withoutSecrets('token=fixtureCredential123456'), '[redacted]');
});

test('camelCase JSON credentials are redacted without removing ordinary keys', () => {
  const ordinary = { primaryKey: 'orders.id', primary_key: 'orders.id', foreignKey: 'customers.id', cacheKey: 'retry-cache', maxTokens: '4096', monkey: 'example' };
  const credentials = { accessToken: 'fixture access', refreshToken: 'fixture "quoted" \\ tail', refresh_token: 'fixture refresh', openaiApiKey: 'fixture key', dbPassword: 'fixture password' };
  assert.equal(containsSecret(JSON.stringify(ordinary)), false);
  const text = JSON.stringify({ ...credentials, ...ordinary });
  assert.equal(containsSecret(text), true);
  const redacted = withoutSecrets(text);
  assert.deepEqual(JSON.parse(redacted), { ...Object.fromEntries(Object.keys(credentials).map((key) => [key, '[redacted]'])), ...ordinary });
  assert.equal(containsSecret(redacted), false);
  assert.equal(withoutSecrets(redacted), redacted);
});

test('the saved candidate, model prompt and Proxy body exclude JSON credentials', () => {
  const secret = /fixture(?:Credential|Refresh)123456/;
  const detail = JSON.stringify({ password: 'fixtureCredential123456', refreshToken: 'fixtureRefresh123456' });
  const candidate = candidateOf({
    prompt: 'Fix upload retry with ' + detail,
    record: {
      answer: 'Retry now works with ' + detail,
      commands: ['npm test -- ' + detail],
      paths: [],
      checks: [{ command: 'npm test -- ' + detail, failed: false }],
    },
  });
  const body = distillBody({ platform: 'test', sessionId: 'test-session', candidate, args: { summary: 'Repair upload retry' } });
  for (const text of [JSON.stringify(candidate), distillPrompt(candidate, detail), JSON.stringify(body)]) {
    assert.doesNotMatch(text, secret);
    assert.match(text, /\[redacted\]/);
    assert.match(text, /upload retry/);
  }
});
