import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DIFF_MAX_BYTES, projectSnapshotOf } from '../../lib/runtime/project.js';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-project-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

test('a work tree snapshot is its root, HEAD and a diff that rebuilds it on HEAD, untracked files included, the index untouched', async (t) => {
  const dir = repo(t);
  writeFileSync(join(dir, 'a.js'), 'export const a = 2;\n');
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'lib', 'new.js'), 'export const b = 3;\n');
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'dep.js'), 'ignored\n');
  const statusBefore = git(dir, 'status', '--porcelain');
  const snapshot = await projectSnapshotOf().snapshot(join(dir, 'lib'));
  assert.equal(git(dir, 'status', '--porcelain'), statusBefore);
  assert.deepEqual([snapshot.root, snapshot.head], [git(dir, 'rev-parse', '--show-toplevel').trim(), git(dir, 'rev-parse', 'HEAD').trim()]);
  assert.doesNotMatch(snapshot.diff, /node_modules/);

  const copy = mkdtempSync(join(tmpdir(), 'evolver-copy-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  git(copy, 'clone', '-q', dir, '.');
  git(copy, 'checkout', '-q', snapshot.head);
  execFileSync('git', ['apply'], { cwd: copy, input: snapshot.diff });
  assert.equal(readFileSync(join(copy, 'a.js'), 'utf8'), 'export const a = 2;\n');
  assert.equal(readFileSync(join(copy, 'lib', 'new.js'), 'utf8'), 'export const b = 3;\n');

  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(DIFF_MAX_BYTES));
  const big = await projectSnapshotOf().snapshot(dir);
  assert.deepEqual([big.diff, big.diff_truncated], [undefined, true]);
});

test('a folder outside any git repository, or one before its first commit, has no snapshot', async (t) => {
  const plain = mkdtempSync(join(tmpdir(), 'evolver-plain-'));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  assert.equal(await projectSnapshotOf().snapshot(plain), null);
  git(plain, 'init', '-q');
  assert.equal(await projectSnapshotOf().snapshot(plain), null);
});
