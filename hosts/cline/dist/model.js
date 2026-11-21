// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { processStartTime } from '../../../lib/channels/plugin/adapter.js';

const PROVIDER = 'openai-compatible';
const MAX_CONFIG = 1024 * 1024;
const MAX_REPLY = 1024 * 1024;
const MAX_TOKENS = 2_048;
const LAUNCH_PROBE_COOLDOWN_MS = 30_000;
const identityOf = ({ dev, ino, size, mtimeNs, ctimeNs }) => [dev, ino, size, mtimeNs, ctimeNs].join(':');
const unavailable = (reason) => Object.assign(new Error('The Cline model route is unavailable'), { code: 'MODEL_UNAVAILABLE', reason });

// Cline's Windows plugin worker shares the native PID but sees a stripped argv.
// Check a narrow launch shape in the process probe without returning its arguments.
function clineStartTime() {
  const root = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  if (process.platform !== 'win32' || !isAbsolute(root)) return null;
  const probe = String.raw`
    $hostProcess = Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}'
    if ($hostProcess.Name -ne 'cline.exe') { exit 1 }
    $token = '"[^"\r\n]*(?<!\\)"|[^\s"]+'
    $line = $hostProcess.CommandLine
    if (!$line -or $line -notmatch ('^\s*(?:' + $token + ')(?:\s+(?:' + $token + '))*\s*$')) { exit 1 }
    $items = @([regex]::Matches($line, $token) | ForEach-Object { $_.Value.Trim('"') })
    $interactive = $false
    for ($index = 1; $index -lt $items.Count; $index++) {
      $arg = $items[$index]
      if ($arg -cin @('--tui','-i')) { $interactive = $true; continue }
      if ($arg -cin @('--cwd','--config','--data-dir','--auto-approve')) {
        $index++
        if ($index -ge $items.Count -or !$items[$index] -or $items[$index].StartsWith('-')) { exit 1 }
        continue
      }
      if ($arg.StartsWith('-') -or $index -ne $items.Count - 1) { exit 1 }
    }
    if (!$interactive) { exit 1 }
  `;
  const shell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', probe], { timeout: 2_000, windowsHide: true });
  if (result.error?.code === 'ETIMEDOUT') return undefined;
  return result.status === 0 ? processStartTime(process.pid) : null;
}

function savedRoute(env, startedAt) {
  const path = env.CLINE_PROVIDER_SETTINGS_PATH?.trim();
  if (env.CLINE_SESSION_BACKEND_MODE !== 'local' || env.CLINE_API_KEY || !path || !isAbsolute(path)) return null;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_CONFIG) || Number(before.ctimeMs) >= startedAt
      || Number(before.mtimeMs) >= startedAt) return null;
    const fd = openSync(path, 'r');
    let raw;
    try {
      if (identityOf(fstatSync(fd, { bigint: true })) !== identityOf(before)) return null;
      raw = readFileSync(fd, 'utf8');
      if (identityOf(fstatSync(fd, { bigint: true })) !== identityOf(before)) return null;
    } finally { closeSync(fd); }
    if (identityOf(lstatSync(path, { bigint: true })) !== identityOf(before)) return null;
    const doc = JSON.parse(raw);
    const entry = doc?.providers?.[PROVIDER];
    const settings = entry?.settings;
    // shortcut: only the static native API-key schema can prove account identity without a Cline credential interface.
    if (doc?.version !== 1 || doc.lastUsedProvider !== PROVIDER || (doc.modes && Object.keys(doc.modes).length)
      || !settings || settings.provider !== PROVIDER || (entry.tokenSource && entry.tokenSource !== 'manual')
      || Object.keys(settings).some((key) => !['provider', 'apiKey', 'model', 'baseUrl'].includes(key))) return null;
    const { apiKey, model } = settings;
    if (typeof apiKey !== 'string' || !/^[!-~]{1,2048}$/.test(apiKey)
      || typeof model !== 'string' || !/^[\w.@:/+-]{1,256}$/.test(model)) return null;
    const endpoint = new URL(settings.baseUrl ?? 'https://api.openai.com/v1');
    if (!(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname)))
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/chat/completions';
    return { apiKey, model, endpoint, identity: identityOf(before) };
  } catch { return null; }
}

async function responseBody(response) {
  if (!response.body) throw new Error('Cline completion returned no response');
  const reader = response.body.getReader();
  let length = 0;
  const decoder = new TextDecoder();
  let body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(body + decoder.decode());
      length += value.byteLength;
      if (length > MAX_REPLY) throw new Error('Cline completion exceeded its response limit');
      body += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); }
}

/** The opaque binding is usable only by this live hook sandbox and is never an API key or a URL. */
export function createClineModel({ env = process.env, startedAt = clineStartTime, now = () => performance.now() } = {}) {
  const secret = randomBytes(32);
  let boot;
  let timedOut = false;
  let probeAfter = 0;
  function readRoute() {
    if (env.CLINE_SESSION_BACKEND_MODE !== 'local' || !env.CLINE_PROVIDER_SETTINGS_PATH) return null;
    if (boot === undefined && now() >= probeAfter) {
      boot = startedAt();
      if (boot === undefined) {
        if (timedOut) probeAfter = now() + LAUNCH_PROBE_COOLDOWN_MS;
        timedOut = true;
      }
    }
    const route = boot && savedRoute(env, boot);
    if (!route) return null;
    const { apiKey, endpoint, model, identity } = route;
    const configDigest = createHmac('sha256', secret).update(JSON.stringify([apiKey, endpoint.href, model, identity])).digest('hex');
    return { ...route, descriptor: { configDigest, selection: { providerId: PROVIDER, modelId: model } } };
  }

  return {
    capture: () => readRoute()?.descriptor ?? null,
    background: false,
    async complete(descriptor, prompt, stopping) {
      const checkedRoute = () => {
        const route = readRoute();
        if (!route || descriptor?.configDigest !== route.descriptor.configDigest
          || descriptor?.selection?.providerId !== PROVIDER || descriptor?.selection?.modelId !== route.model) throw unavailable('route_changed');
        return route;
      };
      const signal = stopping ? AbortSignal.any([stopping, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000);
      signal.throwIfAborted();
      const { apiKey, endpoint, model } = checkedRoute();
      let data;
      try {
        const response = await fetch(endpoint, {
          method: 'POST', redirect: 'error', signal,
          headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({ model, stream: false, store: false, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: prompt }] }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('Cline completion was refused');
        }
        data = await responseBody(response);
      } catch {
        signal.throwIfAborted();
        throw new Error('Cline completion failed');
      }
      signal.throwIfAborted();
      checkedRoute();
      const choice = data?.choices?.length === 1 ? data.choices[0] : null;
      const message = choice?.message;
      const answer = message?.content;
      const calls = message?.tool_calls;
      const withoutTools = calls == null || (Array.isArray(calls) && calls.length === 0);
      if (data?.model !== model || choice?.finish_reason !== 'stop' || message?.role !== 'assistant'
        || !withoutTools || message.function_call != null || typeof answer !== 'string' || !answer.trim()) {
        throw new Error('Cline returned no complete answer on the captured model');
      }
      const { prompt_tokens: inputTokens, completion_tokens: outputTokens } = data?.usage ?? {};
      return { answer, ...(Number.isSafeInteger(inputTokens) && inputTokens >= 0 && Number.isSafeInteger(outputTokens) && outputTokens >= 0
        && { usage: { inputTokens, outputTokens } }) };
    },
  };
}
