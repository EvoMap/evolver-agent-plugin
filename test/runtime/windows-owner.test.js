import assert from 'node:assert/strict';
import { test } from 'node:test';

import { windowsAncestorsOf } from '../../lib/runtime/process/windows.js';

test('Windows queries bounded ancestry with a pinned PowerShell executable and no command-line collection', () => {
  let invocation;
  const result = windowsAncestorsOf(123, { env: { SystemRoot: 'C:\\Windows' }, run: (...args) => {
    invocation = args;
    return { status: 0, stdout: '[{"pid":123,"ppid":12,"name":"cmd.exe","path":"C:\\\\Windows\\\\cmd.exe"}]' };
  } });
  assert.equal(result.get(123).ppid, 12);
  assert.equal(invocation[0], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(invocation[2].timeout, 2500);
  assert.equal(invocation[2].windowsHide, true);
  assert.ok(invocation[1].includes('-NoProfile'));
  assert.equal(invocation[1].join(' ').includes('CommandLine'), false);
});

test('CIM denial, timeout, invalid JSON, malformed identity and invalid PID all remain unknown', () => {
  for (const result of [{ status: 1, stdout: '' }, { error: { code: 'ETIMEDOUT' } }, { status: 0, stdout: 'bad' }, { status: 0, stdout: '[{"pid":"123","ppid":12,"name":"cmd.exe","path":""}]' }]) {
    assert.equal(windowsAncestorsOf(123, { env: { SystemRoot: 'C:\\Windows' }, run: () => result }).size, 0);
  }
  assert.equal(windowsAncestorsOf(-1, { run: () => { throw new Error('must not execute'); } }).size, 0);
});
