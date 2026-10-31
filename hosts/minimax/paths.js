// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** MiniMax strips data-root variables from hooks; only its native v2 PLUGIN_DATA layout is inferred. */
export function dataDirOf(env) {
  const explicit = env.MINIMAX_DATA_DIR || env.MAVIS_DATA_DIR;
  if (explicit) return resolve(explicit);
  if (env.PLUGIN_DATA) {
    const hooks = dirname(env.PLUGIN_DATA), data = dirname(hooks), version = dirname(data);
    if (basename(hooks) !== 'hooks' || basename(data) !== 'plugin-data' || basename(version) !== 'v2') throw new Error('MiniMax plugin data layout is unknown; no model was started');
    return dirname(version);
  }
  return join(env.HOME || env.USERPROFILE || homedir(), '.minimax');
}

export const stateDirOf = env => env.PLUGIN_DATA || join(dataDirOf(env), 'v2', 'plugin-data', 'hooks', 'evolver-plugin');
