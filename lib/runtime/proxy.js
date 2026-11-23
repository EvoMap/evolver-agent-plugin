// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { DEFAULT_PROXY_PORT, proxyResultOf, proxySettingsFrom, timedOutResult, unreachableResult } from '../proxy-response.js';
import { desktopHomeOf } from './engine/desktop.js';

export const PROXY_TIMEOUT_MS = 8_000;
const DESKTOP_PROXY_REQUIRED = 'The EvoMap Desktop Proxy is starting or could not be verified. Wait a moment and run evolver-status again.';

function settingsText(env, desktopPaths) {
  const home = desktopPaths ? desktopHomeOf(env) : env.HOME || env.USERPROFILE || homedir();
  const file = desktopPaths && env.EVOLVER_PROXY_SETTINGS_FILE?.trim();
  const directory = desktopPaths && env.EVOLVER_SETTINGS_DIR?.trim();
  try {
    return readFileSync(file ? resolve(home, file) : join(directory ? resolve(home, directory) : join(home, '.evolver'), 'settings.json'), 'utf8');
  } catch {
    return '';
  }
}

function lifecycleReceiptOf(env) {
  const home = desktopHomeOf(env);
  const root = env.EVOLVER_HOME ?? env.EVOMAP_HOME ?? join(home, '.evomap');
  const state = env.EVOLVER_LIFECYCLE_STATE_DIR?.trim() || join(root, 'lifecycle');
  const name = env.EVOLVER_LIFECYCLE_NAME ?? 'evolver-proxy';
  const file = resolve(home, env.EVOLVER_LIFECYCLE_PID_FILE ?? join(state, `${name}.pid`));
  try {
    const stat = lstatSync(file);
    return stat.isFile() && stat.size <= 64 * 1024 ? JSON.parse(readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
}

function proxyRecordOf(text) {
  try {
    return JSON.parse(text)?.proxy;
  } catch {
    return undefined;
  }
}

const validPid = (pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fff_ffff;
const samePath = (expected, actual) => typeof actual === 'string' && isAbsolute(actual) && relative(expected, actual) === '';

function ownedByDesktop(selection, record, receipt, pid) {
  if (!validPid(pid) || record?.pid !== pid || record.version !== selection.version || receipt?.pid !== pid ||
      receipt.owner !== 'evolver-lifecycle' || !samePath(selection.command, receipt.command) || !Array.isArray(receipt.args)) return false;
  const [entry, subcommand] = receipt.args;
  if (selection.args.length === 0) return receipt.args.length === 1 && entry === 'proxy';
  if (receipt.args.length === 2) return samePath(selection.args[0], entry) && subcommand === 'proxy';
  return receipt.args.length === 1 && selection.proxyBins?.().some((binary) => samePath(binary, entry));
}

function isLivePid(pid) {
  if (!validPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function desktopProofOf(selection, record, receipt, endpoint, pid) {
  if (!endpoint.token || !isLivePid(pid) || !ownedByDesktop(selection, record, receipt, pid)) return null;
  // Bind the authenticated process to the same endpoint, login token and lifecycle receipt across hook invocations.
  return createHash('sha256').update(JSON.stringify([
    endpoint.url, endpoint.token, pid, record.version, record.started_at, receipt.command, receipt.args, receipt.createdAt,
  ])).digest('hex');
}

/** A cold launch must leave any still-running process named by Evolver's files alone. */
export function desktopProxyMayStart(env) {
  return !isLivePid(proxyRecordOf(settingsText(env, true))?.pid) && !isLivePid(lifecycleReceiptOf(env)?.pid);
}

/** `proxyFetch(method, path, body, { timeoutMs, signal })` against the loopback Proxy, answering a ProxyResult; never throws. */
export function proxyFetchOf(env = process.env, { closeConnection = false, clientHeaders = () => ({}), desktopEngine, desktopProof } = {}) {
  return async (method, path, body, { timeoutMs = PROXY_TIMEOUT_MS, signal } = {}) => {
    try {
      const selection = desktopEngine?.();
      const text = settingsText(env, Boolean(selection));
      const endpoint = proxySettingsFrom(text, env.EVOMAP_PROXY_PORT || DEFAULT_PROXY_PORT);
      if (selection) {
        const record = proxyRecordOf(text);
        const proof = desktopProofOf(selection, record, lifecycleReceiptOf(env), endpoint, record?.pid);
        if (!proof || proof !== desktopProof?.()) return { ok: false, error: DESKTOP_PROXY_REQUIRED };
      }
      return await sendProxyRequest(endpoint, method, path, body, { timeoutMs, signal, closeConnection, clientHeaders });
    } catch (error) {
      return { ok: false, error: String(error.message ?? error) };
    }
  };
}

async function sendProxyRequest({ url: base, token }, method, path, body, { timeoutMs, signal, closeConnection, clientHeaders }) {
  const headers = { ...clientHeaders(), ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }), ...(closeConnection && { Connection: 'close' }) };
  // AbortSignal.timeout throws on a fractional delay, which a wait measured from performance.timeOrigin has.
  const timeout = AbortSignal.timeout(Math.ceil(timeoutMs));
  try {
    // Draft publication releases its correction lock once this call has started fetch.
    const response = await fetch(base + path, {
      redirect: 'error',
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    return proxyResultOf({ ok: response.ok, status: response.status, text: await response.text() }, base, token);
  } catch (error) {
    return timeout.aborted ? timedOutResult(base, timeoutMs) : unreachableResult(base, error);
  }
}

/** The running Proxy, with its status answer, or null when none answers. */
export async function runningProxy({ env = process.env, timeoutMs = 1_500, desktopEngine, closeConnection = false, clientHeaders = () => ({}) } = {}) {
  let selection;
  try {
    selection = desktopEngine?.();
  } catch {
    return null; // Engine setup reports the invalid selection.
  }
  const text = settingsText(env, Boolean(selection));
  const endpoint = proxySettingsFrom(text, env.EVOMAP_PROXY_PORT || DEFAULT_PROXY_PORT);
  const result = await sendProxyRequest(endpoint, 'GET', '/proxy/status', undefined, { timeoutMs, closeConnection, clientHeaders });
  if (!result.ok || result.data?.running !== true) return null;
  const record = proxyRecordOf(text);
  return {
    version: typeof record?.version === 'string' ? record.version : null,
    pid: Number.isInteger(record?.pid) ? record.pid : null,
    data: result.data,
    ...(selection && { desktopProof: desktopProofOf(selection, record, lifecycleReceiptOf(env), endpoint, result.data?.health?.pid) }),
  };
}
