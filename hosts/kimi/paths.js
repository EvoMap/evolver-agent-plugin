// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const SCOPE = /^[a-f0-9]{64}$/;
const NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const kimiHomeOf = (env = {}) => resolve(
  env.KIMI_CODE_HOME || join(env.HOME || env.USERPROFILE || homedir(), '.kimi-code'),
);
export const stateDirOf = (env = {}) => join(kimiHomeOf(env), 'evolver');
export const nativeSessionIdOf = (payload) => typeof payload.session_id === 'string'
  && NATIVE_ID.test(payload.session_id) ? payload.session_id : null;
export const projectDirOf = (payload) => typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : null;

/** The plugin's session id: the Kimi home it was read from (`recordScope`, a pseudonym) and Kimi's own session id. */
export const sessionIdOf = (payload, context = {}) => {
  const id = nativeSessionIdOf(payload);
  return id && SCOPE.test(context.recordScope ?? '') ? JSON.stringify([context.recordScope, id]) : null;
};

/** Kimi's session id in a plugin session id of the Kimi home `scope`; null for another home's. */
export function nativeSessionOf(sessionId, scope) {
  try {
    const [owner, id] = JSON.parse(sessionId);
    return owner === scope && NATIVE_ID.test(id ?? '') ? id : null;
  } catch {
    return null;
  }
}
