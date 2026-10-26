// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The first executable named one of `names`, looked for in `dirs` first (a host's bundled CLI, a per-user install)
 * and then on PATH; null when there is none. On Windows a bare name is an npm shim, which only a shell runs.
 */
export function executableOf({ names, dirs = [] }, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const pathDirs = String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extensions = platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of [...dirs, ...pathDirs]) {
    for (const name of names) {
      for (const extension of extensions) {
        const file = path.join(dir, `${name}${extension}`);
        if (exists(file)) return file;
      }
    }
  }
  return null;
}
