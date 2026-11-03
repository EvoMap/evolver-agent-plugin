import assert from 'node:assert/strict';
import { test } from 'node:test';

import { candidateOf } from '../lib/distill/candidate.js';
import { distillBody, distillPrompt } from '../lib/distill/prompt.js';
import { containsSecret, withoutSecrets } from '../lib/redact.js';

test('redaction removes the complete JSON string and leaves unrelated fields', () => {
  const text = JSON.stringify({ API_KEY: 'fixture "quoted" \\ tail', topic: 'retry' });
  assert.equal(containsSecret(text), true);
  assert.deepEqual(JSON.parse(withoutSecrets(text)), { API_KEY: '[redacted]', topic: 'retry' });
  assert.equal(containsSecret(withoutSecrets(text)), false);
  assert.equal(withoutSecrets('token=fixtureCredential123456'), '[redacted]');
});

test('the saved candidate, model prompt and Proxy body exclude JSON credentials', () => {
  const secret = /fixtureCredential123456/;
  const detail = '{"password":"fixtureCredential123456"}';
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
