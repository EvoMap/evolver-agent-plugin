import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
  git(dir, 'config', 'core.autocrlf', 'false');
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
  git(copy, 'clone', '-q', '--config', 'core.autocrlf=false', dir, '.');
  git(copy, 'checkout', '-q', snapshot.head);
  execFileSync('git', ['apply'], { cwd: copy, input: snapshot.diff });
  assert.equal(readFileSync(join(copy, 'a.js'), 'utf8'), 'export const a = 2;\n');
  assert.equal(readFileSync(join(copy, 'lib', 'new.js'), 'utf8'), 'export const b = 3;\n');

  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(DIFF_MAX_BYTES));
  const big = await projectSnapshotOf().snapshot(dir);
  assert.deepEqual(big, { diff_omitted: 'too_large' });
});

test('a range\'s snapshot is taken from the commit it began on, so work committed meanwhile is in its diff; a base that is gone falls back to HEAD', async (t) => {
  const dir = repo(t);
  const probe = projectSnapshotOf();
  const start = await probe.head(dir);
  assert.deepEqual(start, { root: git(dir, 'rev-parse', '--show-toplevel').trim(), head: git(dir, 'rev-parse', 'HEAD').trim() });
  writeFileSync(join(dir, 'a.js'), 'export const a = 2;\n');
  git(dir, 'commit', '-qam', 'committed during the range');
  writeFileSync(join(dir, 'b.js'), 'export const b = 3;\n');
  const snapshot = await probe.snapshot(dir, { base: start.head });
  assert.equal(snapshot.head, start.head);
  assert.match(snapshot.diff, /\+export const a = 2;[\s\S]*\+export const b = 3;/);
  const gone = await probe.snapshot(dir, { base: 'e'.repeat(40) });
  assert.equal(gone.head, git(dir, 'rev-parse', 'HEAD').trim());
});

test('a work tree whose diff holds a secret, or touches a file keys are kept in, sends no diff at all; a name that only holds such a name does not', async (t) => {
  for (const [file, text] of [
    ['credentials.txt', 'harmless\n'], ['a.js', 'PRIVATE_CREDENTIAL=unique-secret-123\n'],
    ['deploy.yml', 'deploy_token: unique-secret-123\n'], ['.docker/config.json', '{"harmless": true}\n'],
    ['settings.json', '{"token":"opaque-example-123456789"}\n'], ['settings.json', '{"accessToken":"opaque-example-123456789"}\n'],
    ['deploy.json', '{"DEPLOY_TOKEN":"opaque-example-123456789"}\n'],
  ]) {
    const dir = repo(t);
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
    const snapshot = await projectSnapshotOf().snapshot(dir);
    assert.deepEqual(snapshot, { diff_omitted: 'secret' }, file);
    assert.doesNotMatch(JSON.stringify(snapshot), /unique-secret-123|harmless|opaque-example/);
  }
  const dir = repo(t);
  writeFileSync(join(dir, 'docs .env example.txt'), 'harmless\n');
  writeFileSync(join(dir, 'client.js'), "fetch(url, { credentials: 'include' });\n");
  writeFileSync(join(dir, 'settings.json'), '{"primaryKey":"orders.id","maxTokens":"4096","monkey":"example"}\n');
  const { diff } = await projectSnapshotOf().snapshot(dir);
  assert.match(diff, /\+harmless/);
  assert.match(diff, /\+fetch\(url, \{ credentials: 'include' \}\);/);
  assert.match(diff, /\+\{"primaryKey":"orders.id","maxTokens":"4096","monkey":"example"\}/);
});

test('fresh snapshots omit credential objects and arrays, including multiline values with quoted braces', async (t) => {
  const dir = repo(t);
  for (const content of [
    '{"token":{"value":"opaqueFixtureObject"}}',
    '{"refreshToken":["opaqueFixtureArray"]}',
    JSON.stringify({ token: { values: [
      { value: 'opaqueFixtureNested', closing: '} ]', quoted: 'escaped "quote" and { [' },
      ['ordinary', { closing: '] }' }],
    ] } }, null, 2),
  ]) {
    const text = content + '\n';
    writeFileSync(join(dir, 'settings.json'), text);
    const statusBefore = git(dir, 'status', '--porcelain');
    const snapshot = await projectSnapshotOf().snapshot(dir);
    assert.deepEqual(snapshot, { diff_omitted: 'secret' });
    assert.doesNotMatch(JSON.stringify(snapshot), /opaqueFixture/);
    assert.equal(git(dir, 'status', '--porcelain'), statusBefore, 'omitting the snapshot leaves the index unchanged');
    assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), text, 'the work tree keeps its original contents');
  }
});

test('fresh snapshots preserve primaryKey scalar, object and array values', async (t) => {
  const dir = repo(t);
  for (const primaryKey of ['orders.id', { columns: ['orders.id'], closing: '} ]' }, ['orders.id', { column: 'tenant.id' }]]) {
    const content = JSON.stringify({ primaryKey });
    writeFileSync(join(dir, 'settings.json'), content + '\n');
    const snapshot = await projectSnapshotOf().snapshot(dir);
    assert.equal(snapshot.root, git(dir, 'rev-parse', '--show-toplevel').trim());
    assert.equal(snapshot.head, git(dir, 'rev-parse', 'HEAD').trim());
    assert.ok(snapshot.diff.includes('+' + content), 'business values remain in the replayable diff');
  }
});

test('a diff a replay cannot rebuild is left out: text that is not UTF-8, or a change inside a submodule', async (t) => {
  const replacement = repo(t);
  writeFileSync(join(replacement, 'a.js'), 'export const mark = "\uFFFD";\n');
  assert.match((await projectSnapshotOf().snapshot(replacement)).diff, /\+export const mark = "\uFFFD";/, 'U+FFFD is text like any other');

  const latin1 = repo(t);
  writeFileSync(join(latin1, 'legacy.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  assert.deepEqual(await projectSnapshotOf().snapshot(latin1), { diff_omitted: 'not_utf8' });

  const parent = repo(t);
  const child = repo(t);
  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'vendor');
  git(parent, 'commit', '-qm', 'vendor');
  writeFileSync(join(parent, 'vendor', 'a.js'), 'export const a = 2;\n');
  assert.deepEqual(await projectSnapshotOf().snapshot(parent), { diff_omitted: 'submodule' });
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

test('a scratch index keeps a same-size tracked edit with the index timestamp', async (t) => {
  const dir = repo(t);
  const tracked = join(dir, 'a.js');
  const index = join(dir, '.git', 'index');
  const time = new Date('2020-01-01T00:00:00Z');
  git(dir, 'config', 'core.checkStat', 'minimal');
  git(dir, 'config', 'core.trustctime', 'false');
  utimesSync(tracked, time, time);
  git(dir, 'add', 'a.js');
  utimesSync(index, time, time);
  const indexBefore = readFileSync(index);
  const indexTime = statSync(index).mtimeMs;

  writeFileSync(tracked, 'export const a = 2;\n');
  utimesSync(tracked, time, time);
  writeFileSync(join(dir, 'new.txt'), 'untracked\n');
  assert.match(git(dir, '--no-optional-locks', 'diff', 'HEAD'), /\+export const a = 2;/);

  const { diff } = await projectSnapshotOf().snapshot(dir);
  assert.match(diff, /\+export const a = 2;/);
  assert.match(diff, /\+untracked/);
  assert.deepEqual(readFileSync(index), indexBefore);
  assert.equal(statSync(index).mtimeMs, indexTime);
});

test('a folder outside any git repository, or one before its first commit, has no snapshot', async (t) => {
  const plain = mkdtempSync(join(tmpdir(), 'evolver-plain-'));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  assert.equal(await projectSnapshotOf().snapshot(plain), null);
  git(plain, 'init', '-q');
  assert.equal(await projectSnapshotOf().snapshot(plain), null);
});
