import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkEvidenceOf, checkIdentityOf, checkKindOf, staleSignalOf } from '../lib/checks.js';

test('every check command maps onto the four kinds the Hub accepts', () => {
  assert.equal(checkKindOf('npx -p typescript tsc -p .'), 'typecheck');
  assert.equal(checkKindOf('npm run lint'), 'lint');
  assert.equal(checkKindOf('claude plugin validate .'), 'lint');
  assert.equal(checkKindOf('node --test test/*.test.js'), 'test');
  assert.equal(checkKindOf('cargo build --release'), 'build');
  assert.equal(checkKindOf('make'), 'build');
});

test('the last check decides, and a failure of that same command earlier marks a turnaround', () => {
  assert.equal(checkEvidenceOf([]), undefined);
  assert.deepEqual(checkEvidenceOf([{ command: 'npm test', failed: true }, { command: 'npm test', failed: false }]), { kind: 'test', passed: true, fail_then_pass: true });
  assert.deepEqual(checkEvidenceOf([{ command: 'npm run lint', failed: true }, { command: 'npm test', failed: false }]), { kind: 'test', passed: true, fail_then_pass: false });
  assert.deepEqual(checkEvidenceOf([{ command: 'npm test', failed: false }, { command: 'npm test', failed: true }]), { kind: 'test', passed: false, fail_then_pass: false });
});

test('an unknown last result is no check evidence; an earlier unknown result is no failure', () => {
  assert.equal(checkEvidenceOf([{ command: 'npm test', failed: false }, { command: 'npm test', failed: null }]), undefined);
  assert.deepEqual(checkEvidenceOf([{ command: 'npm test', failed: null }, { command: 'npm test', failed: false }]),
    { kind: 'test', passed: true, fail_then_pass: false });
});

test('the same check is recognised when only its output trimming differs', () => {
  const checks = [
    { command: 'cd /tmp/lru-e2e && node --test 2>&1 | tail -12', failed: true },
    { command: 'cd /tmp/lru-e2e && node --test 2>&1 | tail -9', failed: false },
  ];
  assert.deepEqual(checkEvidenceOf(checks), { kind: 'test', passed: true, fail_then_pass: true });
  assert.equal(checkIdentityOf('npm test  2>&1 | grep -v "^ok" | head -40'), 'npm test');
  assert.equal(checkIdentityOf('npm run build > build.log 2>&1 && npm test | tail -3'), 'npm run build && npm test');
});

test('different checks stay different, and a logical or is not an output pipe', () => {
  assert.notEqual(checkIdentityOf('npm test | tail -5'), checkIdentityOf('npm run lint | tail -5'));
  assert.notEqual(checkIdentityOf('cd a && npm test'), checkIdentityOf('cd b && npm test'));
  assert.equal(checkIdentityOf('npm test || true'), 'npm test || true');
  assert.equal(checkEvidenceOf([{ command: 'npm run lint | tail -3', failed: true }, { command: 'npm test | tail -3', failed: false }]).fail_then_pass, false);
});

test('a failed check whose output names a deprecated endpoint, unknown flag, missing export or missing path yields a sanitized stale signal', () => {
  assert.equal(staleSignalOf({ command: 'npm test', failed: false, output: 'error: unknown option --legacy' }), null);
  assert.equal(staleSignalOf({ command: 'npm test', failed: true, output: 'AssertionError: expected 1 to equal 2' }), null);
  assert.equal(staleSignalOf({ command: 'npm test', failed: true, output: "error: unknown option '--legacy-mode'" }), 'unknown_flag');
  assert.equal(staleSignalOf({ command: 'pytest', failed: true, output: 'pytest: error: unrecognized arguments: --old-flag' }), 'unknown_flag');
  assert.equal(staleSignalOf({ command: 'pytest', failed: true, output: 'error: unrecognized option --old-flag' }), 'unknown_flag');
  assert.equal(staleSignalOf({ command: 'npm test', failed: true, output: 'HTTP/1.1 410 Gone' }), 'http_404_410');
  assert.equal(staleSignalOf({ command: 'npm test', failed: true, output: 'Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath ./v1 is not defined' }), 'missing_export');
  assert.equal(staleSignalOf({ command: 'npm test', failed: true, output: "ENOENT: no such file or directory, open '/secret/refactored/path.js'" }), 'missing_target_path');
  assert.equal(staleSignalOf({ command: 'npm test', failed: true, stale_signal: 'unknown_flag' }), 'unknown_flag');
  assert.equal(staleSignalOf({ command: 'npm test', failed: true, stale_signal: 'arbitrary_untrusted_text' }), null);
});

test('stale HTTP signals use the actual status of a failed HTTP assertion', () => {
  const signal = (output) => staleSignalOf({ command: 'npm test', failed: true, output });
  assert.equal(signal('AssertionError: expected status code 404 but received 500'), null);
  assert.equal(signal('AssertionError: expected status 410, got status 503'), null);
  assert.equal(signal('AssertionError: expected status code 200 but received 404'), 'http_404_410');
  assert.equal(signal('HTTP/2 404 Not Found'), 'http_404_410');
  assert.equal(signal('HTTP/1.1 410 Gone'), 'http_404_410');
  assert.equal(signal('expected status code 404 but received 500\nHTTP/1.1 410 Gone'), 'http_404_410');
  assert.equal(signal('expected status code 404 but received 500\nerror: unknown option --legacy'), 'unknown_flag');
});
