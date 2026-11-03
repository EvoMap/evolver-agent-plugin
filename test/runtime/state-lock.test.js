import assert from 'node:assert/strict';
import fs from 'node:fs';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { updateState, withLock } from '../../lib/runtime/store/file-lock.js';

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

test('an admission cleanup failure is surfaced instead of silently orphaning a live guard', async (t) => {
  const { lock } = scratch(t);
  const admission = `${lock}.admission`;
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (target) => {
    if (dirname(String(target)) === admission) throw Object.assign(new Error('refused by fixture'), { code: 'EPERM' });
    return unlink(target);
  };
  let entered = false;
  try {
    await assert.rejects(withLock(lock, async () => { entered = true; }), { code: 'ELOCKED' });
  } finally {
    fs.unlinkSync = unlink;
  }
  assert.equal(entered, false);
  assert.equal(existsSync(lock), false, 'the failed acquire must not leave a work lock');
  assert.match(readdirSync(admission)[0], new RegExp(`^owner-${process.pid}-`));
  assert.equal(await withLock(lock, async () => { entered = true; }), true);
  assert.equal(entered, true);
});
