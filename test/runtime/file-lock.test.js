import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { withLock } from '../../lib/runtime/store/file-lock.js';

const RUNTIME = new URL('../../lib/runtime/store/file-lock.js', import.meta.url).href;
const STALE = new Date(0);

function scratch(t, token = null) {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-work-lock-'));
  const lock = join(dir, 'work.lock');
  if (token !== null) {
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), token);
  }
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, lock };
}

async function until(check) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the lock contender');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function holdAdmission(lock, pid = process.pid) {
  const admission = `${lock}.admission`;
  const owner = join(admission, `owner-${pid}-deadbeef`);
  mkdirSync(admission);
  writeFileSync(owner, 'fixture owner');
  return { admission, owner, release: () => { unlinkSync(owner); rmdirSync(admission); } };
}

test('stale legacy and dead-owner directories recover, but a fresh legacy lock stays held', async (t) => {
  const { lock } = scratch(t, 'legacy token');
  let entered = 0;
  assert.equal(await withLock(lock, async () => { entered += 1; }), false);
  utimesSync(lock, STALE, STALE);
  assert.equal(await withLock(lock, async () => { entered += 1; }), true);
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner'), `${exited.pid}:deadbeef`);
  holdAdmission(lock, exited.pid);
  utimesSync(lock, STALE, STALE);
  assert.equal(await withLock(lock, async () => { entered += 1; }), true);
  assert.equal(entered, 2);
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(`${lock}.admission`), false);
});

test('an old mtime never evicts a live owner, which can refresh and release its lock', async (t) => {
  const { dir, lock } = scratch(t);
  assert.equal(await withLock(lock, async (held) => {
    utimesSync(lock, STALE, STALE);
    let entered = false;
    assert.equal(await withLock(lock, async () => { entered = true; }), false);
    assert.equal(entered, false);
    held.refresh();
    assert.ok(statSync(lock).mtimeMs > STALE.getTime());
  }), true);
  assert.equal(existsSync(lock), false);
  assert.deepEqual(readdirSync(dir), []);
});

test('release waits asynchronously for transient admission contention', async (t) => {
  const { lock } = scratch(t);
  let guard;
  let finished = false;
  let refreshedAt;
  const running = withLock(lock, async (held) => {
    guard = holdAdmission(lock);
    utimesSync(lock, STALE, STALE);
    held.refresh();
    refreshedAt = statSync(lock).mtimeMs;
  }).then(() => { finished = true; });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(refreshedAt, STALE.getTime(), 'refresh also respects admission');
    assert.equal(finished, false);
    assert.equal(existsSync(lock), true);
  } finally {
    guard.release();
    await running;
  }
  assert.equal(existsSync(lock), false);
});

test('release refuses bounded admission contention without deleting the held directory', async (t) => {
  const { lock } = scratch(t);
  let guard;
  const started = Date.now();
  await assert.rejects(withLock(lock, async () => {
    guard = holdAdmission(lock);
  }), { code: 'ELOCKED' });
  assert.ok(Date.now() - started < 5_000, 'cleanup cannot wait forever');
  assert.equal(existsSync(lock), true);
  assert.equal(readFileSync(guard.owner, 'utf8'), 'fixture owner');
});

test('an admission cleanup failure is surfaced instead of silently orphaning a live guard', async (t) => {
  const { lock } = scratch(t);
  const admission = `${lock}.admission`;
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (target) => {
    if (dirname(target) === admission) throw Object.assign(new Error('refused by fixture'), { code: 'EPERM' });
    return unlink(target);
  };
  let entered = false;
  try {
    await assert.rejects(withLock(lock, async () => { entered = true; }), { code: 'ELOCKED' });
  } finally {
    fs.unlinkSync = unlink;
  }
  assert.equal(entered, false);
  assert.match(readdirSync(admission)[0], new RegExp(`^owner-${process.pid}-`));
});

test('a transient admission cleanup refusal retries and leaves later work unblocked', async (t) => {
  const { dir, lock } = scratch(t);
  const unlink = fs.unlinkSync;
  let refused = false;
  fs.unlinkSync = (target) => {
    if (dirname(target) === `${lock}.admission` && !refused) {
      refused = true;
      throw Object.assign(new Error('temporarily refused by fixture'), { code: 'EPERM' });
    }
    return unlink(target);
  };
  let entered = 0;
  try {
    assert.equal(await withLock(lock, async () => { entered += 1; }), true);
  } finally {
    fs.unlinkSync = unlink;
  }
  assert.equal(refused, true);
  assert.equal(entered, 1);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(await withLock(lock, async () => { entered += 1; }), true);
  assert.equal(entered, 2);
  assert.deepEqual(readdirSync(dir), []);
});

test('busy and unrecognised admission guards stay intact and leave no staging directories', async (t) => {
  const { dir, lock } = scratch(t);
  const guard = holdAdmission(lock);
  assert.equal(await withLock(lock, async () => assert.fail('a live guard is held')), false);
  assert.deepEqual(readdirSync(dir), ['work.lock.admission']);
  writeFileSync(join(guard.admission, 'unexpected'), 'keep');
  assert.equal(await withLock(lock, async () => assert.fail('multiple owners are unknown')), false);
  assert.equal(readdirSync(guard.admission).length, 2);
  unlinkSync(guard.owner);
  assert.equal(await withLock(lock, async () => assert.fail('an unknown owner is held')), false);
  assert.equal(readFileSync(join(guard.admission, 'unexpected'), 'utf8'), 'keep');
  assert.deepEqual(readdirSync(dir), ['work.lock.admission']);
});

test('two contenders cannot replace the fresh lock while another reclaims a stale directory', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-work-lock-'));
  const lock = join(dir, 'work.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner'), 'legacy token');
  utimesSync(lock, STALE, STALE);
  const marker = (name) => join(dir, name);
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { withLock } from ${JSON.stringify(RUNTIME)};
    const [dir, lock, role] = process.argv.slice(1);
    const marker = (name) => path.join(dir, name);
    const wait = async (name) => {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(marker(name))) {
        if (Date.now() > deadline) throw new Error('timed out waiting for ' + name);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    if (role === 'A') {
      const stat = fs.statSync;
      let paused = false;
      fs.statSync = (file, ...args) => {
        const result = stat(file, ...args);
        if (file === lock && !paused) {
          paused = true;
          fs.writeFileSync(marker('stale-read'), '');
          const deadline = Date.now() + 10000;
          while (!fs.existsSync(marker('resume'))) {
            if (Date.now() > deadline) throw new Error('timed out waiting to resume');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        return result;
      };
    }
    const result = await withLock(lock, async () => {
      fs.writeFileSync(marker(role + '-entered'), '');
      await wait('release');
    });
    fs.writeFileSync(marker(role + '-result'), JSON.stringify(result));
  `;
  const children = [];
  const run = (role) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir, lock, role]);
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
    children.push({ child, done });
  };
  t.after(async () => {
    writeFileSync(marker('resume'), '');
    writeFileSync(marker('release'), '');
    await Promise.all(children.map(({ done }) => done));
    rmSync(dir, { recursive: true, force: true });
  });
  run('A');
  await until(() => existsSync(marker('stale-read')));
  run('B');
  run('C');
  await until(() => ['B', 'C'].every((role) => existsSync(marker(role + '-entered')) || existsSync(marker(role + '-result'))));
  writeFileSync(marker('resume'), '');
  await until(() => existsSync(marker('A-entered')));
  const entered = ['A', 'B', 'C'].filter((role) => existsSync(marker(role + '-entered')));
  writeFileSync(marker('release'), '');
  const results = await Promise.all(children.map(({ done }) => done));
  assert.ok(results.every(({ code }) => code === 0), JSON.stringify(results));
  assert.deepEqual(entered, ['A'], 'only the process reclaiming the inspected stale directory may enter');
  assert.deepEqual(['A', 'B', 'C'].map((role) => JSON.parse(readFileSync(marker(role + '-result'), 'utf8'))), [true, false, false]);
});

test('a delayed dead-admission reclaimer cannot unlink the fresh owner another contender published', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-admission-race-'));
  const lock = join(dir, 'work.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner'), 'legacy token');
  utimesSync(lock, STALE, STALE);
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  holdAdmission(lock, exited.pid);
  const marker = (name) => join(dir, name);
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { withLock } from ${JSON.stringify(RUNTIME)};
    const [dir, lock, role] = process.argv.slice(1);
    const marker = (name) => path.join(dir, name);
    const waitSync = (name) => {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(marker(name))) {
        if (Date.now() > deadline) throw new Error('timed out waiting for ' + name);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    };
    if (role === 'A') {
      const list = fs.readdirSync;
      let paused = false;
      fs.readdirSync = (file, ...args) => {
        const result = list(file, ...args);
        if (file === lock + '.admission' && !paused) {
          paused = true;
          fs.writeFileSync(marker('dead-inspected'), '');
          waitSync('A-resume');
        }
        return result;
      };
    }
    if (role === 'B') {
      const rename = fs.renameSync;
      let paused = false;
      fs.renameSync = (source, target) => {
        const result = rename(source, target);
        if (target === lock + '.admission' && !paused) {
          paused = true;
          fs.writeFileSync(marker('fresh-held'), '');
          waitSync('B-resume');
        }
        return result;
      };
    }
    const result = await withLock(lock, async () => {
      fs.writeFileSync(marker(role + '-entered'), '');
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(marker('release'))) {
        if (Date.now() > deadline) throw new Error('timed out waiting to release');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
    fs.writeFileSync(marker(role + '-result'), JSON.stringify(result));
  `;
  const children = [];
  const run = (role) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir, lock, role]);
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
    children.push({ child, done });
    return child;
  };
  t.after(async () => {
    for (const name of ['A-resume', 'B-resume', 'release']) writeFileSync(marker(name), '');
    await Promise.all(children.map(({ done }) => done));
    rmSync(dir, { recursive: true, force: true });
  });
  run('A');
  await until(() => existsSync(marker('dead-inspected')));
  const fresh = run('B');
  await until(() => existsSync(marker('fresh-held')));
  run('C');
  await until(() => existsSync(marker('C-result')) || existsSync(marker('C-entered')));
  assert.equal(existsSync(marker('C-entered')), false, 'publishing a fresh guard never exposes an empty directory');
  writeFileSync(marker('A-resume'), '');
  await until(() => existsSync(marker('A-result')) || existsSync(marker('A-entered')));
  assert.equal(existsSync(marker('A-entered')), false, 'the delayed reclaimer cannot displace the fresh guard');
  assert.equal(readdirSync(`${lock}.admission`).length, 1);
  assert.match(readdirSync(`${lock}.admission`)[0], new RegExp(`^owner-${fresh.pid}-`));
  writeFileSync(marker('B-resume'), '');
  await until(() => existsSync(marker('B-entered')));
  assert.deepEqual(['A', 'B', 'C'].filter((role) => existsSync(marker(role + '-entered'))), ['B']);
  writeFileSync(marker('release'), '');
  const results = await Promise.all(children.map(({ done }) => done));
  assert.ok(results.every(({ code }) => code === 0), JSON.stringify(results));
  assert.deepEqual(['A', 'B', 'C'].map((role) => JSON.parse(readFileSync(marker(role + '-result'), 'utf8'))), [false, true, false]);
});
