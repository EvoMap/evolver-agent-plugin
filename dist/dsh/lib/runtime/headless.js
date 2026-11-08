// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const HEADLESS_MARKER = 'EVOLVER_HEADLESS';
const WORKDIR_MARKER = '.evolver-headless';
const CONTENT = `${HEADLESS_MARKER}=1\n`;

/** The private scratch marker survives hosts which remove inherited environment variables from their hooks. */
export function markHeadlessWorkdir(dir) {
  writeFileSync(join(dir, WORKDIR_MARKER), CONTENT, { mode: 0o600, flag: 'wx' });
}

export function isHeadlessRun(env = process.env, cwd = process.cwd()) {
  if (env[HEADLESS_MARKER] === '1') return true;
  if (typeof cwd !== 'string' || !basename(cwd).startsWith('evolver-model-')) return false;
  const normalized = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  if (normalized(dirname(cwd)) !== normalized(tmpdir())) return false;
  try {
    const file = join(cwd, WORKDIR_MARKER);
    const stat = lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === Buffer.byteLength(CONTENT) && readFileSync(file, 'utf8') === CONTENT;
  } catch { return false; }
}

export const headlessEnv = (env = process.env) => ({ ...env, [HEADLESS_MARKER]: '1' });
