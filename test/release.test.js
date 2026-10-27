import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { mismatchesFor, tagOf, tagsNamed, versionsNamed } from '../scripts/release-version.mjs';

const PUBLISH = fileURLToPath(new URL('../scripts/publish-tag.sh', import.meta.url));
const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('every host ships one version, and every marketplace and install step names its tag', () => {
  const [{ version }] = versionsNamed();
  assert.deepEqual(mismatchesFor(version), []);
  assert.ok(versionsNamed().length >= 16, 'every manifest is counted');
  assert.ok(tagsNamed().every((named) => named.tag === tagOf(version)));
  assert.ok(tagsNamed().some((named) => named.file === 'README.md'), 'the install steps name the tag too');
});

test('a tag that does not match the manifests is refused before anything is published', () => {
  const [{ version }] = versionsNamed();
  const other = version === '9.9.9' ? '9.9.8' : '9.9.9';
  const mismatches = mismatchesFor(other);
  assert.ok(mismatches.some((line) => line.startsWith('package.json: version')));
  assert.ok(mismatches.some((line) => line.startsWith('.claude-plugin/marketplace.json: tag')));
});

test('only a pushed vX.Y.Z tag publishes, after the tests, by checking, packing and re-pointing the tag', () => {
  assert.match(workflow, /tags: \['v\*'\]/);
  assert.match(workflow, /needs: test\n\s+if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  const publish = workflow.slice(workflow.indexOf('  publish:'));
  const steps = ['release-version.mjs check', 'npm run pack', 'publish-tag.sh', 'gh release create'].map((step) => publish.indexOf(step));
  assert.ok(steps.every((at, index) => at > 0 && (index === 0 || at > steps[index - 1])), 'check, pack, publish, then the GitHub Release');
  assert.doesNotMatch(workflow, /publish-release-branch|refs\/heads\/main' && github\.event_name/);
});

const posix = { skip: process.platform === 'win32' && 'bash script' };

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
}

function releaseRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'evolver-tag-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(root, 'clone', '--quiet', origin, work);
  writeFileSync(join(work, 'README.md'), 'source\n');
  git(work, 'add', '.');
  git(work, 'commit', '--quiet', '-m', 'source');
  git(work, 'push', '--quiet', 'origin', 'HEAD:main');
  return { origin, work };
}

const publish = (cwd, tag) => execFileSync('bash', [PUBLISH, tag], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'ci', GIT_AUTHOR_EMAIL: 'ci@ci', GIT_COMMITTER_NAME: 'ci', GIT_COMMITTER_EMAIL: 'ci@ci' } });

test('publishing a tag on main re-points it at the source plus dist/, once', posix, (t) => {
  const { origin, work } = releaseRepo(t);
  const source = git(work, 'rev-parse', 'HEAD');
  git(work, 'tag', 'v1.2.3');
  git(work, 'push', '--quiet', 'origin', 'v1.2.3');
  mkdirSync(join(work, 'dist', 'codex'), { recursive: true });
  writeFileSync(join(work, 'dist', 'codex', 'plugin.json'), '{}\n');
  publish(work, 'v1.2.3');
  const published = git(origin, 'rev-parse', 'v1.2.3^{commit}');
  assert.notEqual(published, source);
  assert.equal(git(origin, 'rev-parse', `${published}^`), source, 'one commit on top of the tagged source');
  assert.equal(git(origin, 'show', `${published}:dist/codex/plugin.json`), '{}');
  assert.equal(git(origin, 'show', `${published}:README.md`), 'source');
  rmSync(join(work, 'dist'), { recursive: true });
  git(work, 'fetch', '--quiet', '--force', 'origin', 'refs/tags/v1.2.3:refs/tags/v1.2.3');
  git(work, 'checkout', '--quiet', 'v1.2.3');
  assert.match(publish(work, 'v1.2.3'), /already holds dist\/: it is published/);
  assert.equal(git(origin, 'rev-parse', 'v1.2.3^{commit}'), published, 'a re-run moves nothing');
});

test('a tag on a commit that is not on main is refused', posix, (t) => {
  const { origin, work } = releaseRepo(t);
  git(work, 'checkout', '--quiet', '-b', 'side');
  writeFileSync(join(work, 'README.md'), 'side\n');
  git(work, 'commit', '--quiet', '-am', 'side');
  git(work, 'tag', 'v2.0.0');
  git(work, 'push', '--quiet', 'origin', 'v2.0.0');
  mkdirSync(join(work, 'dist'));
  writeFileSync(join(work, 'dist', 'x'), 'x');
  assert.throws(() => publish(work, 'v2.0.0'), /not on main/);
  assert.equal(git(origin, 'rev-parse', 'v2.0.0^{commit}'), git(work, 'rev-parse', 'HEAD'));
});
