import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { startDetached } from '../../lib/runtime/process/spawn.js';
import { startWithoutInheritedHandles } from '../../lib/runtime/process/windows-worker.js';

const node = process.execPath;

test('an isolated Windows launch builds only trusted code and shares its fixed deadline', (t) => {
  const env = { EVOLVER_WINDOWS_WORKER: 'inherited value', QA_MARKER: 'fixture' };
  const cwd = join(tmpdir(), 'worker 中文');
  const commandLine = '"node" -- "a quoted argument" "方案🌿"';
  let scratch, calls = 0, now = 0;
  t.mock.method(performance, 'now', () => now);
  const pid = startWithoutInheritedHandles(tmpdir(), node, commandLine, {
    cwd, env, run(command, args, options) {
      assert.equal(options.windowsHide, true);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore']);
      if (++calls === 1) {
        assert.equal(command, join(dirname(tmpdir()), 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'));
        assert.equal(options.timeout, 2_000);
        scratch = options.cwd;
        assert.notEqual(scratch, cwd, 'the compiler never reads response files from the project');
        assert.deepEqual(args, ['/nologo', '/noconfig', '/target:exe', '/out:' + join(scratch, 'worker.exe'), join(scratch, 'worker.cs')]);
        const source = readFileSync(args.at(-1), 'utf8');
        assert.equal(source.includes(commandLine), false, 'arguments are data, never compiled code');
        assert.equal(source.includes(env.EVOLVER_WINDOWS_WORKER), false);
        now = 500;
        return { status: 0 };
      }
      assert.equal(command, join(scratch, 'worker.exe'));
      assert.deepEqual(args, []);
      assert.equal(options.timeout, 1_500, 'compilation must consume the same two-second budget');
      assert.deepEqual(Buffer.from(options.env.EVOLVER_WINDOWS_WORKER, 'base64').toString('utf16le').split('\0'),
        [node, commandLine, cwd]);
      assert.equal(options.cwd, cwd);
      assert.equal(options.env.QA_MARKER, 'fixture');
      return { status: 0, stdout: '1234\r\n' };
    },
  });
  assert.equal(pid, 1234);
  assert.equal(calls, 2);
  assert.equal(existsSync(scratch), false);
  assert.deepEqual(env, { EVOLVER_WINDOWS_WORKER: 'inherited value', QA_MARKER: 'fixture' });
});

test('an isolated Windows launch accepts only a complete successful PID acknowledgement', () => {
  for (const [result, expected] of [
    [{ status: 0, stdout: '1234\r\n' }, 1234],
    [{ status: null, stdout: '1234\n', error: { code: 'ETIMEDOUT' } }, 1234],
    [{ status: null, stdout: '', error: { code: 'ETIMEDOUT' } }, undefined],
    [{ status: null, stdout: '1234', error: { code: 'ETIMEDOUT' } }, undefined],
    [{ status: 1, stdout: '1234\n' }, undefined],
    [{ status: null, stdout: '1234\n', error: { code: 'ENOENT' } }, undefined],
    [{ status: 0, stdout: 'warning\n1234\n' }, undefined],
    [{ status: 0, stdout: '0\n' }, undefined],
  ]) {
    assert.equal(startWithoutInheritedHandles(tmpdir(), node, '"node"', {
      cwd: tmpdir(), env: {}, run: (command) => command.endsWith('csc.exe') ? { status: 0 } : result,
    }), expected, JSON.stringify(result));
  }
});

test('an unavailable compiler or exhausted launch budget never starts a worker', (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  for (const compiled of [{ status: null, error: { code: 'ENOENT' } }, { status: 1 }, { status: null, error: { code: 'ETIMEDOUT' } }, { status: 0 }]) {
    let calls = 0, scratch;
    const pid = startWithoutInheritedHandles(tmpdir(), node, '"node"', {
      cwd: tmpdir(), env: {}, run(command, args, options) {
        calls++;
        scratch = options.cwd;
        now += 2_000;
        return compiled;
      },
    });
    assert.equal(pid, undefined);
    assert.equal(calls, 1);
    assert.equal(existsSync(scratch), false);
  }
});

test('a malformed Windows launch spec stops before creating a worker', { skip: process.platform !== 'win32' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-worker-invalid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const marker = join(dir, 'worker.json');
  const script = "require('node:fs').writeFileSync(process.env.QA_MARKER,'started')";
  let observed;
  const pid = startWithoutInheritedHandles(join(process.env.SystemRoot, 'System32'), node, `"${node}" -e "${script}"`, {
    cwd: dir, env: { ...process.env, QA_MARKER: marker },
    run(command, args, options) {
      if (command.endsWith('csc.exe')) return spawnSync(command, args, options);
      const parts = Buffer.from(options.env.EVOLVER_WINDOWS_WORKER, 'base64').toString('utf16le').split('\0');
      const invalid = Buffer.from([...parts, 'unexpected field'].join('\0'), 'utf16le').toString('base64');
      observed = spawnSync(command, args, { ...options, env: { ...options.env, EVOLVER_WINDOWS_WORKER: invalid } });
      return observed;
    },
  });
  assert.equal(pid, undefined);
  assert.equal(observed.status, 1, 'the bridge must stop at its validation failure');
  assert.equal(observed.error, undefined);
  assert.equal(observed.stdout, '');
  assert.equal(existsSync(marker), false, 'valid-looking fields must not run after the spec was rejected');
});

test('a Windows worker keeps Unicode arguments and cwd outside its compiled code', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-worker-中文-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const marker = join(dir, 'worker.json');
  const script = "require('node:fs').writeFileSync(process.env.QA_MARKER,JSON.stringify({pid:process.pid,args:process.argv.slice(1),cwd:process.cwd(),spec:process.env.EVOLVER_WINDOWS_WORKER??null}))";
  const args = ['方案🌿', 'with "quotes"', 'with trailing slash\\'];
  const pid = startDetached(node, ['-e', script, '--', ...args], {
    cwd: dir, env: { ...process.env, QA_MARKER: marker }, isolateWindowsHandles: true,
  });
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const deadline = Date.now() + 5_000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { pid, args, cwd: dir, spec: null });
});
