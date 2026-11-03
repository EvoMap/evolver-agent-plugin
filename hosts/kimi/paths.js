// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const kimiHomeOf = (env = {}) => resolve(env.KIMI_CODE_HOME || join(env.HOME || env.USERPROFILE || homedir(), '.kimi-code'));
export const stateDirOf = (env = {}) => join(kimiHomeOf(env), 'evolver');
export const nativeSessionIdOf = payload => typeof payload.session_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(payload.session_id) ? payload.session_id : null;
export const projectDirOf = payload => typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : null;
export const sessionIdOf = (payload, context = {}) => {
  const id = nativeSessionIdOf(payload);
  return id && typeof context.nativeScope === 'string' && /^[a-f0-9]{64}$/.test(context.nativeScope) ? JSON.stringify([context.nativeScope, id]) : null;
};
