// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

function realPathOf(file) {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/**
 * The executable a model declaration names: `{ names, dirs?, accepts?(name, realPath), nodeScriptOnWindows?,
 * windowsShims? }`. Names are tried in order, each on PATH and then in `dirs` (a host's bundled CLI, a per-user
 * install); `accepts` turns down a file that only shares a generic name. On Windows only an `.exe` starts without a
 * shell, except a host's bundled script, which `nodeScriptOnWindows` runs with Node from `dirs`, and an npm `.cmd`
 * shim, which `windowsShims` allows for a CLI whose prompt goes on stdin: cmd.exe cuts a command line at 8191
 * characters. Answers `{ file, viaNode }` or null.
 */
export function executableOf(declaration, { env = process.env, platform = process.platform, exists = existsSync, realPath = realPathOf } = {}) {
  const isWindows = platform === 'win32';
  const viaNode = isWindows && Boolean(declaration.nodeScriptOnWindows);
  const pathDirs = viaNode ? [] : String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extensions = !isWindows || viaNode ? [''] : ['.exe', ...(declaration.windowsShims ? ['.cmd'] : [])];
  for (const name of declaration.names) {
    for (const dir of [...pathDirs, ...(declaration.dirs ?? [])]) {
      for (const extension of extensions) {
        const file = path.join(dir, `${name}${extension}`);
        if (exists(file) && (!declaration.accepts || declaration.accepts(name, realPath(file)))) return { file, viaNode };
      }
    }
  }
  return null;
}
