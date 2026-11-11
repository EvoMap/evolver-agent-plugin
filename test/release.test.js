import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pack, packedHosts, packSpecOf } from '../scripts/pack.mjs';

const PUBLISH = fileURLToPath(new URL('../scripts/publish-tag.sh', import.meta.url));
const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const posix = { skip: process.platform === 'win32' && 'bash script' };
const MANIFEST = /(?:^|\/)(?:kimi\.plugin|plugin|marketplace|package)\.json$/;

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
  assert.match(workflow, /needs: \[test, windows-minimax, windows-kimi\]\r?\n\s+if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  const kimi = workflow.slice(workflow.indexOf('  windows-kimi:'), workflow.indexOf('  publish:'));
  assert.match(kimi, /if: startsWith\(github\.ref, 'refs\/tags\/v'\) \|\| github\.event_name == 'pull_request' \|\| github\.event_name == 'workflow_dispatch'/);
  assert.match(kimi, /runs-on: windows-latest/);
  assert.match(kimi, /node: \[22, 26\]/);
  assert.match(kimi, /run: npm run test:kimi/);
  assert.match(kimi, /run: npm run pack/);
  const windows = workflow.slice(workflow.indexOf('  windows-minimax:'), workflow.indexOf('  windows-kimi:'));
  assert.match(windows, /if: startsWith\(github\.ref, 'refs\/tags\/v'\)\r?\n\s+runs-on: windows-latest\r?\n/);
  assert.match(windows, /node: \[22, 26\]/);
  assert.match(windows, /run: npm run test:minimax/);
  const publish = workflow.slice(workflow.indexOf('  publish:'));
  const steps = ['run: npm ci', '--version=$GITHUB_REF_NAME', 'publish-tag.sh "$GITHUB_REF_NAME" release', 'gh release create'].map((step) => publish.indexOf(step));
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

  assert.match(publishTag(work, 'v1.0.0'), /already holds dist\/: it is published/);
  assert.equal(git(origin, 'rev-parse', 'refs/heads/release'), released, 'retrying the original source preserves the Git stage');

  const second = commitOnMain(work, 'two');
  assert.throws(() => publishTag(work, 'v1.0.0'), /already publishes.*cannot publish/);
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

test('an older published tag cannot resume after a newer release, from its source or its packed checkout', posix, (t) => {
  const { origin, work } = releaseRepo(t);
  commitOnMain(work, 'one source');
  tagAndPack(work, 'v1.0.0');
  publishTag(work, 'v1.0.0');
  const older = git(origin, 'rev-parse', 'refs/heads/release');
  tagAndPack(work, 'v1.0.1');
  publishTag(work, 'v1.0.1');
  const current = git(origin, 'rev-parse', 'refs/heads/release');
  assert.throws(() => publishTag(work, 'v1.0.0'), /older than what release holds/);
  rmSync(join(work, 'dist'), { recursive: true });
  git(work, 'checkout', '--quiet', older);
  assert.throws(() => publishTag(work, 'v1.0.0'), /older than what release holds/);
  assert.equal(git(origin, 'rev-parse', 'refs/heads/release'), current);
  assert.equal(git(origin, 'rev-parse', 'v1.0.0^{commit}'), older);
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

function publicationRun(name) {
  const block = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0];
  assert.ok(block, `publication step ${name} exists`);
  const afterRun = block.split('\n        run: ')[1];
  assert.ok(afterRun, `publication step ${name} runs a command`);
  const [first, ...rest] = afterRun.split('\n');
  if (first !== '|') return first;
  const lines = [];
  for (const line of rest) {
    if (!line.startsWith('          ')) break;
    lines.push(line.slice(10));
  }
  return lines.join('\n');
}

for (const failedStage of ['npm', 'github']) {
  test(`a release interrupted at ${failedStage} reports partial publication and resumes its completed stages`, posix, (t) => {
    const { origin, work } = releaseRepo(t);
    const source = commitOnMain(work, 'release fixture');
    tagAndPack(work, 'v1.0.0');
    mkdirSync(join(work, 'scripts'));
    copyFileSync(PUBLISH, join(work, 'scripts', 'publish-tag.sh'));
    const bin = join(work, 'stub-bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npm'), `#!/usr/bin/env bash
case "$1" in
  view) test -f "$RELEASE_TEST_ROOT/npm-published";;
  publish)
    echo npm >> "$RELEASE_TEST_ROOT/attempts"
    [ "$FAIL_STAGE" != npm ] || exit 1
    touch "$RELEASE_TEST_ROOT/npm-published";;
  *) exit 1;;
esac
`, { mode: 0o755 });
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
case "$1 $2" in
  'release view') test -f "$RELEASE_TEST_ROOT/github-published";;
  'release create')
    echo github >> "$RELEASE_TEST_ROOT/attempts"
    [ "$FAIL_STAGE" != github ] || exit 1
    touch "$RELEASE_TEST_ROOT/github-published";;
  *) exit 1;;
esac
`, { mode: 0o755 });
    const summary = join(work, 'summary.md');
    const env = { ...ENV, PATH: `${bin}${delimiter}${process.env.PATH}`, RELEASE_TEST_ROOT: work, GITHUB_REF_NAME: 'v1.0.0', GITHUB_STEP_SUMMARY: summary, RELEASE_TAG: 'v1.0.0' };
    const stages = [['GIT_RESULT', 'Publish Git bundle'], ['NPM_RESULT', 'Publish @evomap/dsh-evolver to npm'], ['GITHUB_RESULT', 'Publish GitHub Release']];
    const run = (failure = '') => {
      const outcomes = { GIT_RESULT: 'skipped', NPM_RESULT: 'skipped', GITHUB_RESULT: 'skipped' };
      for (const [key, name] of stages) {
        try {
          execFileSync('bash', ['-e', '-o', 'pipefail', '-c', publicationRun(name)], { cwd: work, env: { ...env, FAIL_STAGE: failure }, stdio: 'pipe' });
          outcomes[key] = 'success';
        } catch {
          outcomes[key] = 'failure';
          break;
        }
      }
      execFileSync('bash', ['-e', '-c', publicationRun('Summarize publication')], { cwd: work, env: { ...env, ...outcomes } });
      return Object.values(outcomes);
    };
    assert.match(workflow, /name: Summarize publication\n\s+if: always\(\)/);
    assert.deepEqual(run(failedStage), failedStage === 'npm' ? ['success', 'failure', 'skipped'] : ['success', 'success', 'failure']);
    const released = git(origin, 'rev-parse', 'refs/heads/release');
    assert.equal(git(origin, 'rev-parse', 'v1.0.0^{commit}'), released);
    assert.equal(git(work, 'rev-parse', 'HEAD'), source, 'the rerun starts at the original source SHA');
    const report = readFileSync(summary, 'utf8');
    assert.match(report, /Git bundle \| success/);
    assert.match(report, failedStage === 'npm' ? /npm package \| failure/ : /GitHub Release \| failure/);
    assert.match(report, /rerun the failed workflow jobs/);
    assert.deepEqual(run(), ['success', 'success', 'success']);
    assert.equal(git(origin, 'rev-parse', 'refs/heads/release'), released, 'the published Git commit is retained');
    const attempts = readFileSync(join(work, 'attempts'), 'utf8');
    assert.deepEqual(run(), ['success', 'success', 'success']);
    assert.equal(readFileSync(join(work, 'attempts'), 'utf8'), attempts, 'existing npm and GitHub releases are reused');
    assert.equal(git(origin, 'rev-parse', 'refs/heads/release'), released);
  });
}
