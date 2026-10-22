import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isVerificationCommand, verificationFailed } from '../lib/verification.js';

test('test, build, lint and type-check runs are verifications; other commands are not', () => {
  for (const command of ['npm test', 'pnpm run build', 'yarn lint', 'node --test test/*.test.js', 'npx vitest run', 'go test ./...',
    'cargo clippy', 'npx -p typescript tsc -p .', 'make', 'claude plugin validate .', 'cd app && npm run typecheck']) {
    assert.equal(isVerificationCommand(command), true, command);
  }
  for (const command of ['ls -la', 'git status', 'cat package.json', 'npm install', 'echo test']) {
    assert.equal(isVerificationCommand(command), false, command);
  }
});

test('a non-zero exit fails the verification', () => {
  assert.equal(verificationFailed({ isError: true, text: '' }), true);
});

test('failure output fails it even when the command exited zero', () => {
  assert.equal(verificationFailed({ text: 'AssertionError: expected 1 to equal 2\n1 test failed' }), true);
  assert.equal(verificationFailed({ text: 'TypeError: cannot read properties of undefined' }), true);
});

test('a passing summary that counts zero failures passes', () => {
  assert.equal(verificationFailed({ text: 'ℹ tests 78\nℹ pass 78\nℹ fail 0' }), false);
  assert.equal(verificationFailed({ text: 'Tests: 0 failed, 12 passed' }), false);
  assert.equal(verificationFailed({ text: 'failures: 0\nerrors: 0' }), false);
  assert.equal(verificationFailed({ text: '✔ Validation passed' }), false);
});
