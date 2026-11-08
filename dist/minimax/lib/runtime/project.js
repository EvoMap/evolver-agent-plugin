// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { diffFieldsOf } from '../distill/project-diff.js';
import { runProcess } from './process/spawn.js';

// A turn's end waits for this at most; a diff that takes longer is left out.
const SNAPSHOT_TIMEOUT_MS = 1_000;

// Quoted paths keep every file name ASCII whatever its bytes, so the diff survives as a JSON string. The diff is
// taken against the commit resolved once, so a commit made meanwhile cannot pair one HEAD with another's diff. A
// submodule always shows as its commit line, whatever the person's config hides, so its changes are seen.
const diffArgsOf = (head) => ['-c', 'core.quotePath=on', 'diff', head, '--binary', '--no-color', '--no-ext-diff', '--no-textconv',
  '--submodule=short', '--ignore-submodules=none', '--src-prefix=a/', '--dst-prefix=b/'];

async function git(args, { cwd, env, signal, encoding }) {
  const result = await runProcess('git', args, { cwd, env, signal, encoding });
  return result.code === 0 ? result.stdout : null;
}

const COMMIT = /^[0-9a-f]{40,64}$/;

// A base other than HEAD (the commit a range of turns began on) is used only while it names a commit here.
async function locationOf(dir, options, base) {
  const revision = COMMIT.test(String(base)) ? `${base}^{commit}` : 'HEAD';
  const out = await git(['rev-parse', '--show-toplevel', '--git-path', 'index', '--verify', revision], { ...options, cwd: dir });
  const [root, index, head] = out?.split('\n') ?? [];
  return head ? { root, index: path.resolve(dir, index), head } : null;
}

// Untracked files join the diff as intent-to-add entries of a scratch copy of the index, so the diff shows them as
// new files while the person's own index stays untouched. Git finds them itself: their names never pass through here.
async function workTreeDiff({ root, index, head }, options) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'evolver-diff-'));
  try {
    const scratchIndex = path.join(scratch, 'index');
    await copyFile(index, scratchIndex).catch(() => {});
    const scratchOptions = { ...options, cwd: root, env: { ...options.env, GIT_INDEX_FILE: scratchIndex } };
    const added = await git(['add', '--intent-to-add', '--', '.'], scratchOptions);
    return added === null ? null : await git(diffArgsOf(head), { ...scratchOptions, encoding: 'buffer' });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const gitOptionsOf = (env) => ({ env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) });

/**
 * The git work tree a range of turns ran in, as `{ root, head, diff }`: applying `diff` (the work tree against `head`,
 * untracked files included) to `head` gives the files the last turn's checks ran on. `head` is `base`, the commit the
 * range began on, so changes committed meanwhile are in the diff; HEAD when none is given or `base` is gone. A tree
 * that cannot be rebuilt that way is only `{ diff_omitted }`, the reason (see `diffFieldsOf`), with no root or head
 * that anyone could replay it from. Null outside a git repository or before its first commit. `head(dir)` is
 * `{ root, head }` of HEAD now, null outside a repository.
 */
export function projectSnapshotOf(env = process.env) {
  return {
    async snapshot(dir, { base = null } = {}) {
      const options = gitOptionsOf(env);
      const location = (base && await locationOf(dir, options, base).catch(() => null)) || await locationOf(dir, options).catch(() => null);
      if (!location) return null;
      const diff = await workTreeDiff(location, options).catch(() => null);
      const fields = diffFieldsOf(diff);
      return fields.diff === undefined ? fields : { root: location.root, head: location.head, ...fields };
    },
    async head(dir) {
      const location = await locationOf(dir, gitOptionsOf(env)).catch(() => null);
      return location ? { root: location.root, head: location.head } : null;
    },
  };
}
