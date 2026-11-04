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

async function locationOf(dir, options) {
  const out = await git(['rev-parse', '--show-toplevel', '--git-path', 'index', '--verify', 'HEAD'], { ...options, cwd: dir });
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

/**
 * The git work tree a turn ran in, as `{ root, head, diff?, diff_omitted? }`: applying `diff` (the work tree
 * against `head`, untracked files included) to `head` gives the files the turn's checks ran on. `diff_omitted` says
 * why there is no diff to apply (see `diffFieldsOf`). Null outside a git repository or before its first commit.
 */
export function projectSnapshotOf(env = process.env) {
  return {
    async snapshot(dir) {
      const options = { env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) };
      const location = await locationOf(dir, options).catch(() => null);
      if (!location) return null;
      const diff = await workTreeDiff(location, options).catch(() => null);
      return { root: location.root, head: location.head, ...diffFieldsOf(diff) };
    },
  };
}
