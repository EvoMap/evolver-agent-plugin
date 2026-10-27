// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { normalizeLoopbackUrl } from './loopback.js';

/** @typedef {{ ok: true, data: any } | { ok: false, error: string }} ProxyResult */

export const DEFAULT_PROXY_PORT = '19820';

const START_HINT =
  'Start it by running `evolver` once inside a git repo (the CLI launches the Proxy). '
  + 'Set the proxy_port option if you use a non-default port.';

// The Proxy rotates its loopback URL and bearer token into ~/.evolver/settings.json;
// a URL that is not loopback is ignored so the token never leaves the machine.
export function proxySettingsFrom(settingsText, port) {
  let url = null;
  let token = null;
  try {
    const settings = JSON.parse(settingsText);
    if (settings?.proxy?.url) url = normalizeLoopbackUrl(settings.proxy.url);
    if (settings?.proxy?.token) token = String(settings.proxy.token);
  } catch {
  }
  return { url: url ?? `http://127.0.0.1:${port || DEFAULT_PROXY_PORT}`, token };
}

function httpErrorHint(status, base, token) {
  if (status === 401 || status === 403) {
    return token
      ? ' The Proxy token in ~/.evolver/settings.json was rejected; restart Evolver so it writes fresh settings.'
      : ` No Proxy token was found and the request was rejected — another process may be using ${base}. ${START_HINT}`;
  }
  if (status === 404) return ` Endpoint not found at ${base} — upgrade or verify the Evolver Proxy.`;
  return '';
}

/** @returns {ProxyResult} */
export function timedOutResult(base, timeoutMs) {
  return { ok: false, error: `Proxy request timed out after ${timeoutMs}ms. Evolver Proxy not reachable at ${base}. ${START_HINT}` };
}

/** @returns {ProxyResult} */
export function unreachableResult(base, error) {
  return { ok: false, error: `Proxy connection failed: ${error?.message ?? error}. Evolver Proxy not reachable at ${base}. ${START_HINT}` };
}

/** @returns {ProxyResult} */
export function proxyResultOf(response, base, token) {
  let data;
  try {
    data = response.text ? JSON.parse(response.text) : {};
  } catch {
    data = { raw: response.text };
  }
  if (response.ok) return { ok: true, data };
  return {
    ok: false,
    error: `Proxy at ${base} returned HTTP ${response.status}: ${JSON.stringify(data)}.${httpErrorHint(response.status, base, token)}`,
  };
}
