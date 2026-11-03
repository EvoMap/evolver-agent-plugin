// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PROXY_PORT, proxyResultOf, proxySettingsFrom, timedOutResult, unreachableResult } from '../proxy-response.js';

export const PROXY_TIMEOUT_MS = 8_000;

function settingsText(env) {
  try {
    return readFileSync(join(env.HOME || env.USERPROFILE || homedir(), '.evolver', 'settings.json'), 'utf8');
  } catch {
    return '';
  }
}

/** `proxyFetch(method, path, body, { timeoutMs, signal })` against the loopback Proxy, answering a ProxyResult; never throws. */
export function proxyFetchOf(env = process.env, { closeConnection = false } = {}) {
  return async (method, path, body, { timeoutMs = PROXY_TIMEOUT_MS, signal } = {}) => {
    const { url: base, token } = proxySettingsFrom(settingsText(env), env.EVOMAP_PROXY_PORT || DEFAULT_PROXY_PORT);
    const headers = { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }), ...(closeConnection && { Connection: 'close' }) };
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      return proxyResultOf({ ok: response.ok, status: response.status, text: await response.text() }, base, token);
    } catch (error) {
      return timeout.aborted ? timedOutResult(base, timeoutMs) : unreachableResult(base, error);
    }
  };
}

// The Proxy writes its own version into settings.json when it starts, so this is the version serving
// requests, which can differ from the `evolver` on PATH when another install started it.
function runningVersionOf(env) {
  try {
    const version = JSON.parse(settingsText(env))?.proxy?.version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/** The running Proxy, with its status answer, or null when none answers. */
export async function runningProxy({ env = process.env, proxyFetch = proxyFetchOf(env), timeoutMs = 1_500 } = {}) {
  const result = await proxyFetch('GET', '/proxy/status', undefined, { timeoutMs });
  if (!result.ok || result.data?.running !== true) return null;
  return { version: runningVersionOf(env), data: result.data };
}
