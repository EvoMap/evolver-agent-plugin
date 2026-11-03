import assert from 'node:assert/strict';
import { test } from 'node:test';

import { distillBody, distillPrompt } from '../lib/distill/prompt.js';

test('an earlier unknown check stays unknown in the model record and supplies no fabricated exit code', () => {
  const candidate = {
    prompt: 'Fix the retries', commands: ['npm run lint', 'npm test'], paths: [], answer: 'Fixed.',
    checks: [{ command: 'npm run lint', failed: null }, { command: 'npm test', failed: false }],
  };
  assert.match(distillPrompt(candidate), /- unknown: npm run lint/);
  assert.doesNotMatch(distillPrompt(candidate), /passed: npm run lint/);
  const body = distillBody({ platform: 'codex', sessionId: 's1', candidate, args: {} });
  assert.deepEqual(body.execution.trace, [{ command: 'npm test', exit: 0 }]);
});
