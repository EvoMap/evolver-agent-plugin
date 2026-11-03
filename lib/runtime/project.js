// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runProcess } from './process/spawn.js';

export const DIFF_MAX_BYTES = 256 * 1024;
// A turn's end waits for this at most; a diff that takes longer is left out.
const SNAPSHOT_TIMEOUT_MS = 1_000;
const DIFF_ARGS = ['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];

async function git(args, { cwd, env, signal, input }) {
  const result = await runProcess('git', args, { cwd, env, signal, input });
  return result.code === 0 ? result.stdout : null;
}

async function locationOf(dir, options) {
  const out = await git(['rev-parse', '--show-toplevel', '--git-path', 'index', '--verify', 'HEAD'], { ...options, cwd: dir });
  const [root, index, head] = out?.split('\n') ?? [];
  return head ? { root, index: path.resolve(dir, index), head } : null;
}

// Untracked files join the diff as intent-to-add entries of a scratch copy of the index, so `git diff HEAD` shows
// them as new files while the person's own index stays untouched.
async function workTreeDiff({ root, index }, options) {
  const untracked = await git(['ls-files', '-z', '--others', '--exclude-standard'], { ...options, cwd: root });
  if (untracked === null) return null;
  if (!untracked) return git(DIFF_ARGS, { ...options, cwd: root });
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'evolver-diff-'));
  try {
    const scratchIndex = path.join(scratch, 'index');
    await copyFile(index, scratchIndex).catch(() => {});
    const env = { ...options.env, GIT_INDEX_FILE: scratchIndex };
    const added = await git(['add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul'], { ...options, env, cwd: root, input: untracked });
    return added === null ? null : await git(DIFF_ARGS, { ...options, env, cwd: root });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function diffFieldsOf(diff) {
  if (diff === null) return {};
  return Buffer.byteLength(diff) > DIFF_MAX_BYTES ? { diff_truncated: true } : { diff };
}

/**
 * The git work tree a turn ran in, as `{ root, head, diff?, diff_truncated? }`: applying `diff` (the work tree
 * against HEAD, untracked files included) to `head` gives the files the turn's checks ran on. Null outside a git
 * repository or before its first commit.
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
