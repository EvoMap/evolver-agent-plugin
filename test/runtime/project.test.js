import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DIFF_MAX_BYTES } from '../../lib/distill/project-diff.js';
import { projectSnapshotOf } from '../../lib/runtime/project.js';

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
  assert.deepEqual([big.diff, big.diff_omitted], [undefined, 'too_large']);
});

test('a work tree whose diff holds a secret, or touches a file keys are kept in, sends no diff at all', async (t) => {
  for (const [file, text] of [['credentials.txt', 'harmless\n'], ['a.js', 'PRIVATE_CREDENTIAL=unique-secret-123\n'], ['deploy.yml', 'deploy_token: unique-secret-123\n']]) {
    const dir = repo(t);
    writeFileSync(join(dir, file), text);
    const snapshot = await projectSnapshotOf().snapshot(dir);
    assert.deepEqual([snapshot.diff, snapshot.diff_omitted], [undefined, 'secret'], file);
    assert.doesNotMatch(JSON.stringify(snapshot), /unique-secret-123|harmless/);
  }
});

test('a diff a replay cannot rebuild is left out: text that is not UTF-8, or a change inside a submodule', async (t) => {
  const replacement = repo(t);
  writeFileSync(join(replacement, 'a.js'), 'export const mark = "\uFFFD";\n');
  assert.match((await projectSnapshotOf().snapshot(replacement)).diff, /\+export const mark = "\uFFFD";/, 'U+FFFD is text like any other');

  const latin1 = repo(t);
  writeFileSync(join(latin1, 'legacy.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  assert.equal((await projectSnapshotOf().snapshot(latin1)).diff_omitted, 'not_utf8');

  const parent = repo(t);
  const child = repo(t);
  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'vendor');
  git(parent, 'commit', '-qm', 'vendor');
  writeFileSync(join(parent, 'vendor', 'a.js'), 'export const a = 2;\n');
  assert.equal((await projectSnapshotOf().snapshot(parent)).diff_omitted, 'submodule');
});

test('an untracked file whose name is not UTF-8 keeps the rest of the diff', async (t) => {
  const dir = repo(t);
  try {
    writeFileSync(Buffer.concat([Buffer.from(`${dir}/`), Buffer.from([0x6e, 0xff, 0x2e, 0x74, 0x78, 0x74])]), 'x\n');
  } catch {
    t.skip('this file system takes UTF-8 names only');
    return;
  }
  writeFileSync(join(dir, 'a.js'), 'export const a = 2;\n');
  const { diff } = await projectSnapshotOf().snapshot(dir);
  assert.match(diff, /\+export const a = 2;/);
  assert.match(diff, /"b\/n\\377\.txt"/);
});

test('a folder outside any git repository, or one before its first commit, has no snapshot', async (t) => {
  const plain = mkdtempSync(join(tmpdir(), 'evolver-plain-'));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  assert.equal(await projectSnapshotOf().snapshot(plain), null);
  git(plain, 'init', '-q');
  assert.equal(await projectSnapshotOf().snapshot(plain), null);
});
