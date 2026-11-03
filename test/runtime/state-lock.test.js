import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { updateState } from '../../lib/runtime/store/file-lock.js';

const RUNTIME = new URL('../../lib/runtime/store/file-lock.js', import.meta.url).href;
const BUSY = { code: 'ELOCKED', message: 'State is busy or unavailable; no update was made' };

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-state-lock-'));
  const target = join(dir, 'state.json');
  writeFileSync(target, '{"count":0}');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, target, lock: `${target}.lock` };
}

test('a failed admission release after acquiring a state token lets the next update proceed', (t) => {
  const { target, lock } = scratch(t);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (file) => {
    if (typeof file === 'string' && dirname(file) === `${lock}.admission`) {
      throw Object.assign(new Error('refused by fixture'), { code: 'EPERM' });
    }
    return unlink(file);
  };
  try {
    assert.throws(() => updateState(target, {}, () => assert.fail('mutator must not run')), BUSY);
  } finally {
    fs.unlinkSync = unlink;
  }
  assert.equal(existsSync(lock), false);
  assert.deepEqual(updateState(target, {}, (state) => ({ count: state.count + 1 })), { count: 1 });
});

test('a held state lock never runs an unguarded mutator after its wait expires', (t) => {
  const { target, lock } = scratch(t);
  const held = `${process.pid}:alive`;
  writeFileSync(lock, held);
  let called = false;
  const started = Date.now();
  assert.throws(() => updateState(target, {}, () => { called = true; return { count: 1 }; }), BUSY);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(called, false);
  assert.equal(readFileSync(target, 'utf8'), '{"count":0}');
  assert.equal(readFileSync(lock, 'utf8'), held);
});

test('a legacy dead state owner is recovered, and file permission errors stop before mutation', (t) => {
  const { target, lock } = scratch(t);
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  writeFileSync(lock, `${exited.pid}:deadbeef`);
  assert.deepEqual(updateState(target, {}, (stored) => ({ count: stored.count + 1 })), { count: 1 });
  assert.equal(existsSync(lock), false);
  const write = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => {
    if (file === lock) throw Object.assign(new Error('refused by fixture'), { code: 'EROFS' });
    return write(file, ...args);
  };
  let called = false;
  try {
    assert.throws(() => updateState(target, {}, () => { called = true; return {}; }), BUSY);
  } finally {
    fs.writeFileSync = write;
  }
  assert.equal(called, false);
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { count: 1 });
  assert.deepEqual(updateState(target, {}, (stored) => ({ count: stored.count + 1 })), { count: 2 });
});

test('a transient sharing denial retries outside admission and runs the mutator only once', (t) => {
  const { target, lock } = scratch(t);
  const write = fs.writeFileSync;
  let attempts = 0;
  fs.writeFileSync = (file, ...args) => {
    if (file === lock && ++attempts === 1) throw Object.assign(new Error('temporarily refused by fixture'), { code: 'EPERM' });
    return write(file, ...args);
  };
  let called = 0;
  try {
    assert.deepEqual(updateState(target, {}, (stored) => { called += 1; return { count: stored.count + 1 }; }), { count: 1 });
  } finally {
    fs.writeFileSync = write;
  }
  assert.equal(attempts, 2);
  assert.equal(called, 1);
  assert.equal(existsSync(lock), false);
});

test('an admission setup refusal leaves state unchanged and never calls the mutator', (t) => {
  const { target, lock } = scratch(t);
  const mkdir = fs.mkdirSync;
  fs.mkdirSync = (file, ...args) => {
    if (String(file).startsWith(`${lock}.admission.`)) throw Object.assign(new Error('read-only fixture'), { code: 'EROFS' });
    return mkdir(file, ...args);
  };
  let called = false;
  try {
    assert.throws(() => updateState(target, {}, () => { called = true; return {}; }), BUSY);
  } finally {
    fs.mkdirSync = mkdir;
  }
  assert.equal(called, false);
  assert.equal(readFileSync(target, 'utf8'), '{"count":0}');
  assert.deepEqual(updateState(target, {}, (stored) => ({ count: stored.count + 1 })), { count: 1 });
});

test('a refused dead-owner reclaim obeys the same bounded wait without calling the mutator', async (t) => {
  const { target, lock } = scratch(t);
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  const held = `${exited.pid}:deadbeef`;
  writeFileSync(lock, held);
  const script = `
    import fs from 'node:fs';
    import { updateState } from ${JSON.stringify(RUNTIME)};
    const [target, lock] = process.argv.slice(1);
    const unlink = fs.unlinkSync;
    let reclaims = 0;
    fs.unlinkSync = (file) => {
      if (String(file) === lock) {
        reclaims += 1;
        throw Object.assign(new Error('refused by fixture'), { code: 'EPERM' });
      }
      return unlink(file);
    };
    let called = false;
    try { updateState(target, {}, () => { called = true; return {}; }); }
    catch (error) { process.stdout.write(JSON.stringify({ code: error.code, called, reclaims })); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, target, lock]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 5_000);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(watchdog);
  assert.equal(code, 0, stderr || 'a failed reclaim must not spin forever');
  const result = JSON.parse(stdout);
  assert.equal(result.code, 'ELOCKED');
  assert.equal(result.called, false);
  assert.ok(result.reclaims > 0);
  assert.equal(readFileSync(target, 'utf8'), '{"count":0}');
  assert.equal(readFileSync(lock, 'utf8'), held);
  assert.deepEqual(updateState(target, {}, (stored) => ({ count: stored.count + 1 })), { count: 1 });
});

test('three state updaters preserve every increment while recovering one dead file lock', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-state-lock-race-'));
  const target = join(dir, 'state.json');
  const lock = `${target}.lock`;
  writeFileSync(target, '{"count":0}');
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  const dead = `${exited.pid}:deadbeef`;
  writeFileSync(lock, dead);
  const marker = (name) => join(dir, name);
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { updateState } from ${JSON.stringify(RUNTIME)};
    const [dir, target, lock, role] = process.argv.slice(1);
    const marker = (name) => path.join(dir, name);
    const wait = (name) => {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(marker(name))) {
        if (Date.now() > deadline) throw new Error('timed out waiting for ' + name);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    };
    // Start all contenders before orchestrating the lock interleaving.
    updateState(marker(role + '-startup.json'), {}, () => undefined);
    fs.writeFileSync(marker(role + '-ready'), '');
    wait(role + '-start');
    const read = fs.readFileSync;
    let paused = false;
    fs.readFileSync = (file, ...args) => {
      const result = read(file, ...args);
      if (role === 'A' && file === lock && !paused) {
        paused = true;
        fs.writeFileSync(marker('A-read-dead'), '');
        wait('A-resume');
      }
      return result;
    };
    const rename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      try { return rename(source, destination); }
      catch (error) {
        if (destination === lock + '.admission') fs.writeFileSync(marker(role + '-guard-busy'), '');
        throw error;
      }
    };
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, ...args) => {
      if (file === lock) write(marker(role + '-attempted'), '');
      return write(file, ...args);
    };
    updateState(target, {}, (stored) => {
      try { fs.writeFileSync(marker('active'), role, { flag: 'wx' }); }
      catch { fs.writeFileSync(marker('overlap'), ''); }
      fs.writeFileSync(marker(role + '-entered'), '');
      wait('release');
      if (fs.readFileSync(marker('active'), 'utf8') === role) fs.unlinkSync(marker('active'));
      return { count: stored.count + 1 };
    });
  `;
  const children = [];
  const run = (role) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir, target, lock, role]);
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    children.push(new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr }))));
  };
  const until = async (condition) => {
    const deadline = Date.now() + 10000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the state updater');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  t.after(async () => {
    for (const role of ['A', 'B', 'C']) writeFileSync(marker(role + '-start'), '');
    writeFileSync(marker('A-resume'), '');
    writeFileSync(marker('release'), '');
    await Promise.all(children);
    rmSync(dir, { recursive: true, force: true });
  });
  for (const role of ['A', 'B', 'C']) run(role);
  await until(() => ['A', 'B', 'C'].every((role) => existsSync(marker(role + '-ready'))));
  writeFileSync(marker('A-start'), '');
  await until(() => existsSync(marker('A-read-dead')));
  writeFileSync(marker('B-start'), '');
  await until(() => existsSync(marker('B-entered')) || existsSync(marker('B-guard-busy')));
  assert.equal(existsSync(marker('B-entered')), false, 'the competing process waits for admission');
  writeFileSync(marker('A-resume'), '');
  await until(() => ['A', 'B'].some((role) => existsSync(marker(role + '-entered'))));
  writeFileSync(marker('C-start'), '');
  await until(() => existsSync(marker('C-attempted')) || existsSync(marker('C-guard-busy')));
  writeFileSync(marker('release'), '');
  const results = await Promise.all(children);
  assert.ok(results.every(({ code }) => code === 0), JSON.stringify(results));
  assert.equal(existsSync(marker('overlap')), false, 'state mutators never overlap during dead-owner recovery');
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { count: 3 });
});
