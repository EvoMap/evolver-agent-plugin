import assert from 'node:assert/strict';
import { execFileSync, fork, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

import { modelRunnerOf } from '../../lib/runtime/model-executor.js';
import { capturedModel, COMPLETION_BUDGET_MS, declarationFor } from '../fixtures/acp/declaration.mjs';
import { CHILD_FILE, guardianFile, OWNER_FILE, START_FILE } from '../../lib/runtime/process/acp-child.js';
import { windowsJobExecutable } from '../../lib/runtime/process/windows-job.js';

const SECRET = 'fixture-private-api-key-NOT-A-REAL-CREDENTIAL';

function fixture(t, mode = '') {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-acp-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, 'config.toml');
  writeFileSync(config, `[provider]\nendpoint = "https://example.invalid/v1"\nkey = "${SECRET}"\n`);
  const declaration = declarationFor(config, join(dir, 'receipt.json'), mode);
  const env = { ...process.env, AMBIENT_API_KEY: 'fixture-ambient-key-must-not-be-inherited' };
  return { dir, config, declaration, env, runner: modelRunnerOf(declaration, env) };
}

const pause = ms => new Promise(done => setTimeout(done, ms));
async function until(predicate, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'fixture condition reached its deadline');
    await pause(25);
  }
}

function nativeClosed(dir) {
  const receipt = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'));
  assert.equal(existsSync(receipt.home), false, 'owned scratch has been removed');
  assert.throws(() => process.kill(receipt.pid, 0), 'owned native process has exited');
  if (receipt.descendantPid) assert.throws(() => process.kill(receipt.descendantPid, 0), 'owned native descendant has exited');
}

function promptStarted(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8')).promptStarted === true; } catch { return false; }
}

test('an ACP configuration stamp covers the configuration and its credential without retaining the key', async t => {
  const { runner, config } = fixture(t);
  assert.ok(runner, 'the declaration supplies the model port');
  assert.equal(runner.capture, true);
  const stamp = runner.configStamp();
  assert.match(stamp, /^[a-f0-9]{64}$/);
  assert.equal(runner.configStamp(), stamp);
  writeFileSync(config, readFileSync(config, 'utf8').replace(SECRET, 'different-fixture-key'));
  assert.notEqual(runner.configStamp(), stamp);
});

test('a model captured without a stamp or route cannot run', async t => {
  const { runner, dir } = fixture(t);
  await assert.rejects(runner.complete({ unavailable: 'route_changed' }, 'candidate'), { code: 'MODEL_UNAVAILABLE', reason: 'route_changed' });
  await assert.rejects(runner.complete(null, 'candidate'), { code: 'MODEL_UNAVAILABLE', reason: 'route_unresolved' });
  const model = capturedModel(runner, { alias: 'route-a' });
  await assert.rejects(runner.complete({ ...model, selection: { ...model.selection, model: 'other-model' } }, 'candidate'),
    { code: 'MODEL_UNAVAILABLE', reason: 'route_changed' });
  assert.equal(existsSync(join(dir, 'receipt.json')), false);
});

test('an ACP completion selects the captured route, uses a private credential environment and closes before cleanup', async t => {
  const { runner, dir, declaration } = fixture(t);
  const args = declaration.args(), extras = ['', 'path with spaces', 'trailing slash\\', 'embedded "quote"', 'đường dẫn'];
  declaration.args = () => [...args, ...extras];
  const snapshot = capturedModel(runner, { alias: 'route-a' });
  const answer = await runner.complete(snapshot, 'the private candidate digest', AbortSignal.timeout(COMPLETION_BUDGET_MS));
  assert.equal(answer.answer, 'answer: the private candidate digest');
  const receipt = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'));
  assert.equal(receipt.hasPrivateCredential, true);
  assert.equal(receipt.hasAmbientCredential, false);
  assert.equal(receipt.configContainsCredential, false);
  assert.deepEqual(receipt.argv, extras, 'native arguments survive shell-free quoting');
  assert.equal(receipt.argv.includes('the private candidate digest'), false);
  assert.equal(existsSync(receipt.home), false, 'scratch is deleted after native close');
  assert.throws(() => process.kill(receipt.pid, 0), 'the owned native process has closed');
});

test('a native root exiting normally cannot leave its stdio-ignored descendant alive', { skip: process.platform !== 'win32' }, async t => {
  const { runner, dir } = fixture(t, 'exit-descendant');
  const file = join(dir, 'receipt.json');
  try {
    const result = await runner.complete(capturedModel(runner, { alias: 'route-a' }), 'candidate', AbortSignal.timeout(COMPLETION_BUDGET_MS));
    assert.equal(result.answer, 'answer: candidate');
    const receipt = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(receipt.descendantReady, true);
    assert.throws(() => process.kill(receipt.descendantPid, 0), 'the descendant must be gone even after its parent exited first');
    assert.equal(existsSync(receipt.home), false);
  } finally {
    const receipt = existsSync(file) && JSON.parse(readFileSync(file, 'utf8'));
    if (receipt?.descendantReady) {
      // The nonce endpoint belongs to this fixture; cleanup never signals a possibly reused PID.
      await new Promise(done => {
        const child = createConnection(receipt.descendantPipe);
        child.setTimeout(1000, () => child.destroy());
        child.once('connect', () => child.end(receipt.descendantNonce));
        child.on('error', () => {});
        child.once('close', done);
        child.resume();
      });
    }
  }
});

test('an ACP completion rejects an incomplete trailing frame before accepting native success', async t => {
  const { runner, dir } = fixture(t, 'trailing-frame');
  const snapshot = capturedModel(runner, { alias: 'route-a' });
  await assert.rejects(runner.complete(snapshot, 'candidate', AbortSignal.timeout(COMPLETION_BUDGET_MS)));
  const receipt = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'));
  assert.equal(existsSync(receipt.home), false);
});

test('an ACP completion rejects a late update belonging to another session', async t => {
  const { runner } = fixture(t, 'late-session');
  const snapshot = capturedModel(runner, { alias: 'route-a' });
  await assert.rejects(runner.complete(snapshot, 'candidate', AbortSignal.timeout(COMPLETION_BUDGET_MS)));
});

test('an ACP completion rejects answer chunks sent after the prompt response', async t => {
  const { runner } = fixture(t, 'late-chunk');
  await assert.rejects(runner.complete(capturedModel(runner, { alias: 'route-a' }), 'candidate', AbortSignal.timeout(COMPLETION_BUDGET_MS)));
});

test('a changed configuration or account binding blocks before any native request', async t => {
  const { runner, dir, config, env } = fixture(t);
  const original = readFileSync(config, 'utf8');
  const snapshot = capturedModel(runner, { alias: 'route-a' });
  writeFileSync(config, original.replace('example.invalid', 'other.invalid'));
  await assert.rejects(runner.complete(snapshot, 'candidate'), { code: 'MODEL_UNAVAILABLE', reason: 'route_changed' });
  assert.equal(existsSync(join(dir, 'receipt.json')), false);
  writeFileSync(config, '[provider]\nendpoint="https://example.invalid/v1"\nkey_env="FIXTURE_ACCOUNT_KEY"\n');
  env.FIXTURE_ACCOUNT_KEY = SECRET;
  const envSnapshot = capturedModel(runner, { alias: 'route-a' });
  env.FIXTURE_ACCOUNT_KEY = 'a-different-fixture-account';
  await assert.rejects(runner.complete(envSnapshot, 'candidate'), { code: 'MODEL_UNAVAILABLE', reason: 'route_changed' });
  assert.equal(existsSync(join(dir, 'receipt.json')), false);
  env.FIXTURE_ACCOUNT_KEY = SECRET;
  assert.equal((await runner.complete(envSnapshot, 'candidate', AbortSignal.timeout(COMPLETION_BUDGET_MS))).answer, 'answer: candidate');
  nativeClosed(dir);
});

test('invalid native config yields no stamp and a typed sanitized preflight error', async t => {
  const { runner, config, dir } = fixture(t);
  const model = capturedModel(runner, { alias: 'route-a' });
  writeFileSync(config, `[provider]\nkey = "${SECRET}"\ninvalid = [\n`);
  assert.equal(runner.configStamp(), null);
  await assert.rejects(runner.complete({ ...model, configDigest: 'stale' }, 'candidate'), error => {
    assert.equal(error.code, 'MODEL_UNAVAILABLE');
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
  writeFileSync(config, '#'.repeat(1024 * 1024 + 1));
  assert.equal(runner.configStamp(), null);
  assert.equal(existsSync(join(dir, 'receipt.json')), false);
});

test('an owner exiting before fork does not block a fresh ACP completion', async t => {
  const { runner, config, dir } = fixture(t);
  const homeFile = join(dir, 'orphan-home');
  const ownerFixture = fileURLToPath(new URL('../fixtures/acp/owner.mjs', import.meta.url));
  assert.throws(() => execFileSync(process.execPath, [ownerFixture, config, homeFile, '', 'exit-before-fork'], {
    timeout: 10_000, windowsHide: true, stdio: 'ignore',
  }), { status: 17 });
  const home = realpathSync(readFileSync(homeFile, 'utf8'));
  assert.equal(dirname(home), realpathSync(tmpdir()));
  assert.match(basename(home), /^evolver-model-/);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const marker = join(home, existsSync(join(home, START_FILE)) ? START_FILE : OWNER_FILE);
  const { ownerPid, origin } = JSON.parse(readFileSync(marker, 'utf8'));
  assert.throws(() => process.kill(ownerPid, 0), { code: 'ESRCH' });
  assert.equal(origin, createHash('sha256').update(config).digest('hex'));
  assert.equal(existsSync(join(home, CHILD_FILE)), false);

  const result = await runner.complete(capturedModel(runner, { alias: 'route-a' }), 'fresh candidate');
  assert.equal(result.answer, 'answer: fresh candidate');
  nativeClosed(dir);
  assert.equal(existsSync(home), false, 'the abandoned prelaunch scratch was removed');
});

test('orphan recovery rejects missing or malformed child receipts after launch was claimed', async t => {
  const { runner, config, dir } = fixture(t);
  const orphan = mkdtempSync(join(tmpdir(), 'evolver-model-'));
  t.after(() => rmSync(orphan, { recursive: true, force: true }));
  const ownerPid = 2147483647;
  assert.throws(() => process.kill(ownerPid, 0));
  writeFileSync(join(orphan, OWNER_FILE), JSON.stringify({ nonce: 'a'.repeat(32), ownerPid, origin: createHash('sha256').update(config).digest('hex') }));
  await assert.rejects(runner.complete(capturedModel(runner, { alias: 'route-a' }), 'candidate'), { code: 'MODEL_UNAVAILABLE', reason: 'unsafe_runtime' });
  assert.equal(existsSync(orphan), true);
  for (const content of ['{incomplete', JSON.stringify({ nonce: 'a'.repeat(32) }), JSON.stringify({ nonce: 'b'.repeat(32), guardianPid: ownerPid, nativePid: ownerPid })]) {
    writeFileSync(join(orphan, CHILD_FILE), content);
    await assert.rejects(runner.complete(capturedModel(runner, { alias: 'route-a' }), 'candidate'), { code: 'MODEL_UNAVAILABLE', reason: 'unsafe_runtime' });
    assert.equal(existsSync(orphan), true);
  }
  assert.equal(existsSync(join(dir, 'receipt.json')), false, 'a fresh native process was not started');
});

test('orphan recovery ignores a matching scratch marker with a nonpositive owner PID', async t => {
  const { runner, config } = fixture(t);
  const orphan = mkdtempSync(join(tmpdir(), 'evolver-model-'));
  t.after(() => rmSync(orphan, { recursive: true, force: true }));
  const origin = createHash('sha256').update(config).digest('hex');
  writeFileSync(join(orphan, OWNER_FILE), JSON.stringify({ nonce: 'd'.repeat(32), ownerPid: 0, origin }));
  assert.equal((await runner.complete(capturedModel(runner, { alias: 'route-a' }), 'candidate')).answer, 'answer: candidate');
  assert.equal(existsSync(orphan), true);
});

test('orphan recovery removes only a matching receipt with proof all owned processes are gone', async t => {
  const { runner, config, dir } = fixture(t);
  const orphan = mkdtempSync(join(tmpdir(), 'evolver-model-'));
  t.after(() => rmSync(orphan, { recursive: true, force: true }));
  const dead = 2147483647, nonce = 'c'.repeat(32);
  assert.throws(() => process.kill(dead, 0));
  writeFileSync(join(orphan, OWNER_FILE), JSON.stringify({ nonce, ownerPid: dead, origin: createHash('sha256').update(config).digest('hex') }));
  const receipt = { nonce, guardianPid: dead, nativePid: dead };
  if (process.platform === 'win32') {
    writeFileSync(join(orphan, CHILD_FILE), JSON.stringify(receipt));
    await assert.rejects(runner.complete(capturedModel(runner, { alias: 'route-a' }), 'candidate'), { code: 'MODEL_UNAVAILABLE', reason: 'unsafe_runtime' });
    assert.equal(existsSync(orphan), true, 'dead root PIDs alone cannot prove a Windows job is empty');
    Object.assign(receipt, { helperPid: dead, jobEmpty: true });
  }
  writeFileSync(join(orphan, CHILD_FILE), JSON.stringify(receipt));
  assert.equal((await runner.complete(capturedModel(runner, { alias: 'route-a' }), 'candidate')).answer, 'answer: candidate');
  assert.equal(existsSync(orphan), false);
  nativeClosed(dir);
});

test('cancelling a pending completion waits for its owned native process before removing scratch', async t => {
  const { runner, dir } = fixture(t, 'hang');
  const controller = new AbortController();
  const result = runner.complete(capturedModel(runner, { alias: 'route-a' }), 'candidate', controller.signal);
  const rejection = assert.rejects(result, { code: 'ABORT_ERR' });
  await until(() => promptStarted(dir));
  controller.abort();
  await rejection;
  nativeClosed(dir);
});

test('cancelling after native completion during cleanup rejects the answer after releasing ownership', async t => {
  const { runner, dir, declaration } = fixture(t);
  const controller = new AbortController();
  const decode = declaration.facts.decode;
  let cancelledDuringCleanup = false;
  declaration.facts.decode = records => {
    const facts = decode(records);
    assert.equal(facts.reason, 'completed');
    const receipt = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'));
    assert.throws(() => process.kill(receipt.pid, 0), 'native completion has exited before cleanup');
    assert.equal(existsSync(receipt.home), true, 'the owned scratch is still awaiting release');
    cancelledDuringCleanup = true;
    controller.abort(new Error('fixture cancellation during cleanup'));
    return facts;
  };

  await assert.rejects(runner.complete(capturedModel(runner, { alias: 'route-a' }), 'candidate', controller.signal), { code: 'ABORT_ERR' });
  assert.equal(cancelledDuringCleanup, true);
  nativeClosed(dir);
});

test('a late stop preserves the closed guardian result without signaling the former process group', async t => {
  const base = mkdtempSync(join(tmpdir(), 'evolver-acp-test-'));
  const home = mkdtempSync(join(base, 'evolver-model-'));
  const nonce = 'f'.repeat(32);
  writeFileSync(join(home, START_FILE), JSON.stringify({ nonce }));
  // Observe group signals without letting this test signal a PID that may have been reused.
  const preload = `data:text/javascript,${encodeURIComponent(`
    const kill = process.kill;
    process.kill = (pid, signal) => {
      if (pid < 0 && signal !== 0) {
        process.send({ type: 'group-signal', pid, signal });
        return true;
      }
      return kill.call(process, pid, signal);
    };
  `)}`;
  const spec = { command: process.execPath, args: ['-e', 'void 0'], home, base, nonce, cwd: home, ownerPid: process.pid };
  const guardian = fork(guardianFile, [JSON.stringify(spec)], { execArgv: ['--import', preload], stdio: ['pipe', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const exited = new Promise(done => guardian.once('close', done));
  t.after(async () => {
    guardian.stdin.end();
    if (guardian.connected) guardian.disconnect();
    await exited;
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const messages = [];
  guardian.on('message', message => messages.push(message));
  await until(() => messages.some(message => message.type === 'closed') || guardian.exitCode !== null);
  const closed = messages.find(message => message.type === 'closed');
  assert.deepEqual(closed, { type: 'closed', code: 0, signal: null, treeClosed: true, outputBytes: 0 });
  assert.equal(existsSync(home), true, 'scratch is still awaiting release');
  guardian.stdin.end();
  guardian.send({ type: 'stop' });
  guardian.send({ type: 'release' });
  const code = await exited;

  assert.deepEqual(messages.filter(message => message.type === 'group-signal'), []);
  assert.equal(code, 0, 'late stop does not replace native success with cancellation');
  assert.ok(messages.some(message => message.type === 'cleanup' && message.cleaned));
  assert.equal(existsSync(home), false);
});

test('a stalled POSIX guardian retains ownership until it can stop the native group', { skip: process.platform === 'win32' }, async (t) => {
  const { runner, dir } = fixture(t, 'hang');
  const controller = new AbortController();
  const completion = runner.complete(capturedModel(runner, { alias: 'route-a' }), 'candidate', controller.signal);
  const rejection = assert.rejects(completion, { code: 'ACP_CLEANUP_FAILED' });
  await until(() => promptStarted(dir));
  const receipt = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'));
  const child = JSON.parse(readFileSync(join(receipt.home, CHILD_FILE), 'utf8'));
  assert.equal(child.nativePid, receipt.pid);
  process.kill(child.guardianPid, 'SIGSTOP');
  try {
    controller.abort();
    await rejection;
    assert.doesNotThrow(() => process.kill(child.guardianPid, 0));
  } finally {
    try { process.kill(child.guardianPid, 'SIGCONT'); } catch {}
  }
  await until(() => !existsSync(receipt.home));
  nativeClosed(dir);
});

test('the native guardian cleans its process and marked scratch when its worker dies', async t => {
  const { config, dir } = fixture(t);
  const owner = spawn(process.execPath, [fileURLToPath(new URL('../fixtures/acp/owner.mjs', import.meta.url)), config, join(dir, 'receipt.json')], { windowsHide: true, stdio: 'ignore' });
  t.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); });
  await until(() => existsSync(join(dir, 'receipt.json')));
  const receipt = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'));
  const closed = new Promise(done => owner.once('close', done));
  owner.kill('SIGKILL');
  await closed;
  await until(() => !existsSync(receipt.home));
  nativeClosed(dir);
});

async function activeFixtureJob(dir, ownerPid) {
  await until(() => promptStarted(dir));
  const receipt = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'));
  const home = realpathSync(receipt.home);
  assert.equal(dirname(home), realpathSync(tmpdir()));
  assert.match(basename(home), /^evolver-model-/);
  let child;
  await until(() => {
    try { child = JSON.parse(readFileSync(join(home, CHILD_FILE), 'utf8')); return child.nativePid === receipt.pid && child.helperPid > 0; }
    catch { return false; }
  });
  const marker = JSON.parse(readFileSync(join(home, OWNER_FILE), 'utf8'));
  assert.equal(marker.ownerPid, ownerPid);
  assert.equal(marker.nonce, child.nonce);
  assert.equal(child.jobEmpty, false);
  const pids = [child.guardianPid, child.helperPid, child.nativePid, receipt.descendantPid];
  assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 0));
  pids.forEach(pid => assert.doesNotThrow(() => process.kill(pid, 0)));
  return { home, child, pids };
}

async function assertUnprovenFixtureJobStopped({ home, pids }) {
  await until(() => pids.every(pid => {
    try { process.kill(pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
  }));
  assert.equal(existsSync(home), true, 'scratch stays when no live job-empty proof was delivered');
  assert.equal(JSON.parse(readFileSync(join(home, CHILD_FILE), 'utf8')).jobEmpty, false);
  await rm(home, { recursive: true, maxRetries: 5, retryDelay: 100 }); // Windows can release directory handles after the PIDs disappear.
}

test('an abrupt Windows guardian death kills the whole job but retains scratch without a job-empty proof', { skip: process.platform !== 'win32' }, async t => {
  const { config, dir } = fixture(t);
  const owner = spawn(process.execPath, [fileURLToPath(new URL('../fixtures/acp/owner.mjs', import.meta.url)), config, join(dir, 'receipt.json'), 'hang', 'kill-guardian'], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const closed = new Promise(done => owner.once('close', done));
  t.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); });
  const job = await activeFixtureJob(dir, owner.pid);
  owner.send('kill-guardian');
  assert.equal(await closed, 1);
  await assertUnprovenFixtureJobStopped(job);
});

test('hard-killing the exact Windows job keeper reaps native processes through kill-on-close', { skip: process.platform !== 'win32' }, async t => {
  const { runner, dir } = fixture(t, 'hang');
  const controller = new AbortController();
  const completion = runner.complete(capturedModel(runner, { alias: 'route-a' }), 'candidate', controller.signal);
  const rejected = assert.rejects(completion, { code: 'ACP_CLEANUP_FAILED' });
  try {
    const job = await activeFixtureJob(dir, process.pid);
    const system = process.env.SystemRoot || process.env.WINDIR;
    const powershell = windowsJobExecutable();
    // Hold the process handle while proving image, parent, start time and its unique fixture script.
    execFileSync(powershell, ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', String.raw`
$ErrorActionPreference = 'Stop'
$keeper = [Diagnostics.Process]::GetProcessById([int] $env:EVOLVER_TEST_KEEPER_PID)
try {
  $null = $keeper.Handle
  $row = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $keeper.Id)
  if ($null -eq $row -or $row.ParentProcessId -ne [int] $env:EVOLVER_TEST_GUARDIAN_PID -or
      $row.ExecutablePath -ine $env:EVOLVER_TEST_KEEPER_IMAGE -or
      $keeper.MainModule.FileName -ine $env:EVOLVER_TEST_KEEPER_IMAGE -or
      [Math]::Abs(($keeper.StartTime.ToUniversalTime() - $row.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 1 -or
      $row.CommandLine.IndexOf($env:EVOLVER_TEST_KEEPER_SCRIPT, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw 'Fixture keeper identity mismatch'
  }
  $keeper.Kill()
  if (!$keeper.WaitForExit(2000)) { throw 'Fixture keeper did not exit' }
} finally { $keeper.Dispose() }
`], { windowsHide: true, timeout: 5000, stdio: 'pipe', env: {
      SystemRoot: system, WINDIR: system, EVOLVER_TEST_KEEPER_PID: String(job.child.helperPid), EVOLVER_TEST_GUARDIAN_PID: String(job.child.guardianPid),
      EVOLVER_TEST_KEEPER_IMAGE: powershell, EVOLVER_TEST_KEEPER_SCRIPT: join(job.home, '.evolver-job.ps1'),
    } });
    await rejected;
    await assertUnprovenFixtureJobStopped(job);
  } finally {
    controller.abort();
    await completion.catch(() => {});
    await rejected.catch(() => {});
  }
});

test('the captured thinking choice must match native evidence even when the native default is high', async t => {
  const { runner, dir } = fixture(t, 'ignore-effort');
  await assert.rejects(runner.complete(capturedModel(runner, { alias: 'route-a', effort: 'off' }), 'candidate', AbortSignal.timeout(COMPLETION_BUDGET_MS)));
  nativeClosed(dir);
});

test('ACP selects thinking off explicitly instead of inheriting the native high default', async t => {
  const { runner, dir } = fixture(t);
  assert.equal((await runner.complete(capturedModel(runner, { alias: 'route-a', effort: 'off' }), 'candidate', AbortSignal.timeout(COMPLETION_BUDGET_MS))).answer, 'answer: candidate');
  nativeClosed(dir);
});

test('ACP rejects failed, unverified, truncated or unsafe native completions and cleans the process', async t => {
  for (const mode of ['native-error', 'missing-provider-finish', 'wrong-model', 'tools-loaded', 'native-tool-call', 'missing-proof', 'truncated-proof', 'wrong-session', 'length-cutoff', 'duplicate-response', 'nonzero-exit', 'client-request', 'tool-update', 'output-limit', 'combined-output-limit']) {
    await t.test(mode, async t => {
      const { runner, dir } = fixture(t, mode);
      await assert.rejects(runner.complete(capturedModel(runner, { alias: 'route-a' }), 'candidate', AbortSignal.timeout(COMPLETION_BUDGET_MS)));
      nativeClosed(dir);
    });
  }
});

test('a request deadline cancels the native completion and its inherited descendant', async t => {
  const { runner, dir } = fixture(t, 'hang');
  const controller = new AbortController();
  const rejection = assert.rejects(runner.complete(capturedModel(runner, { alias: 'route-a' }), 'candidate', controller.signal), { code: 'ABORT_ERR' });
  await until(() => promptStarted(dir));
  const deadline = setTimeout(() => controller.abort(), 500);
  try { await rejection; } finally { clearTimeout(deadline); }
  nativeClosed(dir);
});

test('a 500 ms startup abort sends no native prompt and leaves no scratch', async t => {
  const { declaration, env, dir } = fixture(t, 'startup-hang');
  const prepare = declaration.prepare;
  let home;
  declaration.prepare = (selected, context) => { home = context.home; return prepare(selected, context); };
  const runner = modelRunnerOf(declaration, env);
  await assert.rejects(runner.complete(capturedModel(runner, { alias: 'route-a' }), 'candidate', AbortSignal.timeout(500)), { code: 'ABORT_ERR' });
  assert.ok(home);
  assert.equal(existsSync(home), false);
  const file = join(dir, 'receipt.json');
  if (existsSync(file)) {
    assert.notEqual(JSON.parse(readFileSync(file, 'utf8')).promptStarted, true);
    nativeClosed(dir);
  }
});

test('a host Node preload cannot run inside the private credential environment', async t => {
  const { config, dir } = fixture(t);
  const owner = spawn(process.execPath, ['--import', new URL('../fixtures/acp/poison-preload.mjs', import.meta.url).href, fileURLToPath(new URL('../fixtures/acp/owner.mjs', import.meta.url)), config, join(dir, 'receipt.json'), ''], { windowsHide: true, stdio: 'ignore' });
  assert.equal(await new Promise(done => owner.once('close', done)), 0);
  nativeClosed(dir);
});
