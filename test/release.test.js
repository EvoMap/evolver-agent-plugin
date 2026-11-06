import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pack, packedHosts, packSpecOf } from '../scripts/pack.mjs';

const PUBLISH = fileURLToPath(new URL('../scripts/publish-tag.sh', import.meta.url));
const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const posix = { skip: process.platform === 'win32' && 'bash script' };
const MANIFEST = /(?:^|\/)(?:plugin|marketplace|package)\.json$/;

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'evolver-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('packing with a version stamps it into every manifest a packed host reads', (t) => {
  const out = scratch(t);
  for (const host of packedHosts()) {
    pack(host, join(out, host), { version: '9.8.7' });
    const manifests = Object.keys(packSpecOf(host).root).filter((target) => MANIFEST.test(target));
    const versions = manifests.flatMap((target) => [...readFileSync(join(out, host, target), 'utf8').matchAll(/"version"\s*:\s*"([^"]*)"/g)].map((found) => found[1]));
    assert.ok(versions.length > 0, `${host} names a version`);
    assert.ok(versions.every((version) => version === '9.8.7'), `${host}: ${versions}`);
  }
});

test('only a pushed vX.Y.Z tag publishes, after the tests: pack at its version, publish, then the GitHub Release', () => {
  assert.match(workflow, /tags: \['v\*'\]/);
  assert.match(workflow, /needs: \[test, windows-minimax\]\n\s+if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  const windows = workflow.slice(workflow.indexOf('  windows-minimax:'), workflow.indexOf('  publish:'));
  assert.match(windows, /runs-on: windows-latest/);
  assert.match(windows, /node: \[22, 26\]/);
  assert.match(windows, /run: npm run test:minimax/);
  const publish = workflow.slice(workflow.indexOf('  publish:'));
  const steps = ['--version=$GITHUB_REF_NAME', 'publish-tag.sh "$GITHUB_REF_NAME" release', 'gh release create'].map((step) => publish.indexOf(step));
  assert.ok(steps.every((at, index) => at > 0 && (index === 0 || at > steps[index - 1])), steps.join(','));
});

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV }).trim();
const publishTag = (cwd, tag) => execFileSync('bash', [PUBLISH, tag, 'release'], { cwd, encoding: 'utf8', env: ENV });

function releaseRepo(t) {
  const root = scratch(t);
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(root, 'clone', '--quiet', origin, work);
  return { origin, work };
}

function commitOnMain(work, text) {
  writeFileSync(join(work, 'README.md'), `${text}\n`);
  git(work, 'add', 'README.md');
  git(work, 'commit', '--quiet', '-m', text);
  git(work, 'push', '--quiet', 'origin', 'HEAD:main');
  return git(work, 'rev-parse', 'HEAD');
}

function tagAndPack(work, tag) {
  git(work, 'tag', tag);
  git(work, 'push', '--quiet', 'origin', tag);
  rmSync(join(work, 'dist'), { recursive: true, force: true });
  mkdirSync(join(work, 'dist', 'codex'), { recursive: true });
  writeFileSync(join(work, 'dist', 'codex', 'plugin.json'), `{"version":"${tag.slice(1)}"}\n`);
}

test('a tag on main moves the release branch one commit on and points the tag there, once', posix, (t) => {
  const { origin, work } = releaseRepo(t);
  const first = commitOnMain(work, 'one');
  tagAndPack(work, 'v1.0.0');
  publishTag(work, 'v1.0.0');
  const released = git(origin, 'rev-parse', 'refs/heads/release');
  assert.equal(git(origin, 'rev-parse', 'v1.0.0^{commit}'), released, 'the tag and the branch name one commit');
  assert.equal(git(origin, 'show', `${released}:dist/codex/plugin.json`), '{"version":"1.0.0"}');
  assert.match(git(origin, 'log', '-1', '--format=%B', released), new RegExp(`main at ${first}`));
  assert.equal(git(origin, 'rev-parse', 'refs/heads/main'), first, 'main is untouched');

  const second = commitOnMain(work, 'two');
  tagAndPack(work, 'v1.0.1');
  publishTag(work, 'v1.0.1');
  const next = git(origin, 'rev-parse', 'refs/heads/release');
  assert.equal(git(origin, 'rev-parse', `${next}^`), released, 'release only moves forward');
  assert.match(git(origin, 'log', '-1', '--format=%B', next), new RegExp(`main at ${second}`));

  rmSync(join(work, 'dist'), { recursive: true });
  git(work, 'fetch', '--quiet', '--force', 'origin', 'refs/tags/v1.0.1:refs/tags/v1.0.1');
  git(work, 'checkout', '--quiet', 'v1.0.1');
  assert.match(publishTag(work, 'v1.0.1'), /already holds dist\/: it is published/);
  assert.equal(git(origin, 'rev-parse', 'refs/heads/release'), next, 'a re-run moves nothing');
});

test('a tag off main, older than the release, or not vX.Y.Z is refused and moves nothing', posix, (t) => {
  const { origin, work } = releaseRepo(t);
  const old = commitOnMain(work, 'old');
  commitOnMain(work, 'new');
  tagAndPack(work, 'v2.0.0');
  publishTag(work, 'v2.0.0');
  const released = git(origin, 'rev-parse', 'refs/heads/release');

  git(work, 'checkout', '--quiet', old);
  tagAndPack(work, 'v1.9.0');
  assert.throws(() => publishTag(work, 'v1.9.0'), /older than what release holds/);

  git(work, 'checkout', '--quiet', '-b', 'side', old);
  writeFileSync(join(work, 'README.md'), 'side\n');
  git(work, 'commit', '--quiet', '-am', 'side');
  tagAndPack(work, 'v3.0.0');
  assert.throws(() => publishTag(work, 'v3.0.0'), /not on main/);
  assert.throws(() => publishTag(work, 'nightly'), /not a release tag/);
  assert.equal(git(origin, 'rev-parse', 'refs/heads/release'), released);
});
