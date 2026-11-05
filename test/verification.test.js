import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isVerificationCommand, verificationFailed, verificationFailureOf } from '../lib/verification.js';

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

test('a zero count beside a failure does not hide it', () => {
  assert.equal(verificationFailed({ text: 'Tests: 1 failed, 0 errors' }), true);
  assert.equal(verificationFailed({ text: 'failures: 0, errors: 2 — test failed' }), true);
});

test('a passing summary that counts zero failures passes', () => {
  assert.equal(verificationFailed({ text: 'ℹ tests 78\nℹ pass 78\nℹ fail 0' }), false);
  assert.equal(verificationFailed({ text: 'Tests: 0 failed, 12 passed' }), false);
  assert.equal(verificationFailed({ text: 'failures: 0\nerrors: 0' }), false);
  assert.equal(verificationFailed({ text: '✔ Validation passed' }), false);
});

test('missing exit status is unknown unless a supported summary proves the check passed or failed', () => {
  for (const exit of [undefined, null, '0', NaN]) {
    for (const text of ['', 'boom\n', 'done', 'ok', 'ℹ pass 1']) {
      assert.equal(verificationFailureOf({ exit, text }), null, `${exit}/${text}`);
    }
  }
  assert.equal(verificationFailureOf({ exit: 0, text: '' }), false);
  assert.equal(verificationFailureOf({ exit: 3, text: 'done' }), true);
  assert.equal(verificationFailureOf({ text: 'TAP version 13\n# pass 1\n# fail 0\n' }), false);
  assert.equal(verificationFailureOf({ text: 'ℹ pass 3\nℹ fail 0' }), false);
  assert.equal(verificationFailureOf({ text: 'ℹ pass 3\nℹ fail 1' }), true);
  assert.equal(verificationFailureOf({ exit: 0, text: '# pass 1\n# fail 1' }), true);
  assert.equal(verificationFailureOf({ text: 'TypeError: cannot read properties of undefined' }), true);
});

test('a passing summary with cancelled tests does not verify a completed run', () => {
  for (const prefix of ['#', 'ℹ']) {
    const counts = `${prefix} pass 1\n${prefix} fail 0\n${prefix} cancelled `;
    assert.equal(verificationFailureOf({ text: `${counts}1` }), true, prefix);
    assert.equal(verificationFailureOf({ text: `${counts}0` }), false, prefix);
  }
});

test('a heredoc body that names a check is data, not a check; the command lines still count', () => {
  const editsReadme = "python3 - <<'EOF'\ntext = 'run npm test, then make'\nprint(text)\nEOF";
  assert.equal(isVerificationCommand(editsReadme), false);
  assert.equal(isVerificationCommand("cat > notes.md <<EOF\nmake build\nEOF\nnpm test"), true);
  assert.equal(isVerificationCommand('npm test <<EOF\nanswers\nEOF'), true);
});
