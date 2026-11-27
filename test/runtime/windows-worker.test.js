import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { startDetached } from '../../lib/runtime/process/spawn.js';
import { startWithoutInheritedHandles } from '../../lib/runtime/process/windows-worker.js';

const node = process.execPath;

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function until(check) {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(check());
}

function workerFamily(t) {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-worker-family-'));
  const marker = join(dir, 'family.json');
  const worker = join(dir, 'worker.cjs');
  writeFileSync(join(dir, 'child.cjs'), `
    const fs = require('node:fs');
    const marker = process.env.QA_MARKER;
    process.chdir(require('node:os').tmpdir());
    fs.writeFileSync(marker + '.tmp', JSON.stringify({ worker: Number(process.env.QA_WORKER_PID), child: process.pid }));
    fs.renameSync(marker + '.tmp', marker);
    setInterval(() => { if (!fs.existsSync(require('node:path').dirname(marker))) process.exit(0); }, 20);
    setTimeout(() => process.exit(0), 15_000);
  `);
  writeFileSync(worker, `
    const child = require('node:child_process').spawn(process.execPath, [require('node:path').join(process.cwd(), 'child.cjs')], {
      detached: true, stdio: 'ignore', env: { ...process.env, QA_WORKER_PID: String(process.pid) },
    });
    child.unref();
    process.chdir(require('node:os').tmpdir());
    if (process.env.QA_KEEP_WORKER) {
      setInterval(() => { if (!require('node:fs').existsSync(require('node:path').dirname(process.env.QA_MARKER))) process.exit(0); }, 20);
      setTimeout(() => process.exit(0), 15_000);
    }
  `);
  t.after(async () => {
    const family = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : {};
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    for (const pid of Object.values(family)) await until(() => !alive(pid));
  });
  return { dir, marker, commandLine: `"${node}" "${worker}"` };
}

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

test('an isolated Windows launch retains complete PID ownership and reports unconfirmed handoff', () => {
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
    let unconfirmed = 0;
    assert.equal(startWithoutInheritedHandles(tmpdir(), node, '"node"', {
      cwd: tmpdir(), env: {}, onUnconfirmed: () => { unconfirmed++; },
      run: (command) => command.endsWith('csc.exe') ? { status: 0 } : result,
    }), expected, JSON.stringify(result));
    assert.equal(unconfirmed, expected && result.error?.code === 'ETIMEDOUT' ? 1 : 0, JSON.stringify(result));
  }
});

test('an unconfirmed-launch diagnostic cannot lose ownership of a possibly live worker', () => {
  let unconfirmed = 0;
  const pid = startWithoutInheritedHandles(tmpdir(), node, '"node"', {
    cwd: tmpdir(), env: {}, onUnconfirmed: () => { unconfirmed++; throw new Error('diagnostic failed'); },
    run: (command) => command.endsWith('csc.exe') ? { status: 0 }
      : { status: null, stdout: '1234\n', error: { code: 'ETIMEDOUT' } },
  });
  assert.equal(pid, 1234);
  assert.equal(unconfirmed, 1);
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
  const script = "const fs=require('node:fs');const marker=process.env.QA_MARKER;const result=JSON.stringify({pid:process.pid,args:process.argv.slice(1),cwd:process.cwd(),spec:process.env.EVOLVER_WINDOWS_WORKER??null});process.chdir(require('node:os').tmpdir());fs.writeFileSync(marker+'.tmp',result);fs.renameSync(marker+'.tmp',marker)";
  const args = ['方案🌿', 'with "quotes"', 'with trailing slash\\'];
  const pid = startDetached(node, ['-e', script, '--', ...args], {
    cwd: dir, env: { ...process.env, QA_MARKER: marker }, isolateWindowsHandles: true,
  });
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const deadline = Date.now() + 5_000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { pid, args, cwd: dir, spec: null });
});

test('a Windows launch deadline before the PID acknowledgement cleans the worker and its descendants', { skip: process.platform !== 'win32' }, async (t) => {
  const { dir, marker, commandLine } = workerFamily(t);
  let observed;
  const pid = startWithoutInheritedHandles(join(process.env.SystemRoot, 'System32'), node, commandLine, {
    cwd: dir, env: { ...process.env, QA_MARKER: marker, QA_KEEP_WORKER: '1' },
    run(command, args, options) {
      if (command.endsWith('csc.exe')) {
        const source = args.at(-1), text = readFileSync(source, 'utf8');
        assert.ok(text.includes('Console.WriteLine(info.Pid);'));
        writeFileSync(source, text.replace('Console.WriteLine(info.Pid);', 'System.Threading.Thread.Sleep(2500); Console.WriteLine(info.Pid);'));
        return spawnSync(command, args, options);
      }
      assert.ok(options.timeout > 0 && options.timeout <= 2_000, 'the launch keeps its original shared deadline');
      observed = spawnSync(command, args, options);
      return observed;
    },
  });
  assert.equal(pid, undefined);
  assert.equal(observed.error?.code, 'ETIMEDOUT');
  assert.equal(observed.stdout, '', 'there was no PID acknowledgement to recover');
  assert.ok(existsSync(marker), 'the worker and descendant were actually created before the deadline');
  const family = JSON.parse(readFileSync(marker, 'utf8'));
  for (const pid of Object.values(family)) await until(() => !alive(pid));
});

test('a Windows launch deadline after PID output reports uncertainty while retaining process ownership', { skip: process.platform !== 'win32' }, async (t) => {
  for (const handedOff of [false, true]) {
    const { dir, marker, commandLine } = workerFamily(t);
    let observed, unconfirmed = 0;
    const pid = startWithoutInheritedHandles(join(process.env.SystemRoot, 'System32'), node, commandLine, {
      cwd: dir, env: { ...process.env, QA_MARKER: marker, QA_KEEP_WORKER: '1' },
      onUnconfirmed: () => { unconfirmed++; },
      run(command, args, options) {
        if (command.endsWith('csc.exe')) {
          const source = args.at(-1), text = readFileSync(source, 'utf8');
          const anchor = handedOff ? '      return 0;' : 'limits.Basic.Flags = 0x800;';
          assert.ok(text.includes(anchor));
          assert.ok(text.indexOf('Console.Out.Flush();') < text.indexOf(anchor));
          writeFileSync(source, text.replace(anchor, 'System.Threading.Thread.Sleep(2500); ' + anchor));
          return spawnSync(command, args, options);
        }
        assert.ok(options.timeout > 0 && options.timeout <= 2_000, 'the launch keeps its original shared deadline');
        observed = spawnSync(command, args, options);
        return observed;
      },
    });
    assert.equal(observed.error?.code, 'ETIMEDOUT');
    assert.match(observed.stdout, /^[1-9]\d*\r?\n$/, 'the bridge printed a complete PID before timeout');
    assert.ok(existsSync(marker), 'the worker and descendant actually started');
    const family = JSON.parse(readFileSync(marker, 'utf8'));
    assert.equal(pid, family.worker, 'a possibly live worker must remain tracked');
    if (handedOff) for (const pid of Object.values(family)) assert.equal(alive(pid), true);
    else for (const pid of Object.values(family)) await until(() => !alive(pid));
    assert.equal(unconfirmed, 1, 'timeout must never report a confirmed handoff, even with a complete PID');
  }
});

test('a failed Windows launch guard does not leave an unacknowledged worker', { skip: process.platform !== 'win32' }, async (t) => {
  for (const handoff of [false, true]) {
    const { dir, marker, commandLine } = workerFamily(t);
    let observed;
    const pid = startWithoutInheritedHandles(join(process.env.SystemRoot, 'System32'), node, commandLine, {
      cwd: dir, env: { ...process.env, QA_MARKER: marker, QA_KEEP_WORKER: '1' },
      run(command, args, options) {
        if (command.endsWith('csc.exe')) {
          const source = args.at(-1), text = readFileSync(source, 'utf8');
          const anchor = handoff ? 'limits.Basic.Flags = 0x800;' : 'Flags = 0x2000';
          assert.ok(text.includes(anchor));
          writeFileSync(source, text.replace(anchor, handoff
            ? 'while (!System.IO.File.Exists(Environment.GetEnvironmentVariable("QA_MARKER"))) System.Threading.Thread.Sleep(10); limits.Basic.Flags = 0xffffffffu;'
            : 'Flags = 0xffffffffu'));
          return spawnSync(command, args, options);
        }
        observed = spawnSync(command, args, options);
        return observed;
      },
    });
    assert.equal(pid, undefined);
    assert.equal(observed.error, undefined);
    assert.equal(observed.status, 1);
    assert.equal(existsSync(marker), handoff, 'setup failure must stop before creation; handoff failure exercises a live family');
    if (handoff) {
      assert.match(observed.stdout, /^[1-9]\d*\r?\n$/, 'a failed handoff must not be accepted even after printing a PID');
      const family = JSON.parse(readFileSync(marker, 'utf8'));
      for (const pid of Object.values(family)) await until(() => !alive(pid));
    } else assert.equal(observed.stdout, '');
  }
});

test('an acknowledged Windows worker can leave a persistent descendant after it exits', { skip: process.platform !== 'win32' }, async (t) => {
  const { dir, marker, commandLine } = workerFamily(t);
  const pid = startWithoutInheritedHandles(join(process.env.SystemRoot, 'System32'), node, commandLine, {
    cwd: dir, env: { ...process.env, QA_MARKER: marker },
  });
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  await until(() => existsSync(marker));
  const family = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(family.worker, pid);
  await until(() => !alive(pid));
  assert.equal(alive(family.child), true, 'the launch guard must not kill a successfully handed-off Proxy');
});
