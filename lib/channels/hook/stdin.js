// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

const WATCHDOG_MS = 1000;
const MAX_WAIT_MS = 3000;

function parsed(raw) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return null;
  }
}

/**
 * The hook payload on stdin. Some hosts never close stdin, so the payload is taken once it parses as a whole JSON
 * value (or nothing came), waiting up to MAX_WAIT_MS for one still arriving, below the shortest hook timeout.
 * Reading stdin to the end also keeps the host's writer from hitting EPIPE.
 */
export function readPayload(stdin = process.stdin) {
  return new Promise((resolve) => {
    let buffer = '';
    let done = false;
    const startedAt = Date.now();
    const finish = () => {
      if (done) return;
      done = true;
      resolve(parsed(buffer) ?? {});
    };
    const watchdog = () => {
      if (buffer === '' || parsed(buffer) !== null || Date.now() - startedAt >= MAX_WAIT_MS) finish();
      else setTimeout(watchdog, WATCHDOG_MS).unref();
    };
    setTimeout(watchdog, WATCHDOG_MS).unref();
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => { buffer += chunk; });
    stdin.on('end', finish);
    stdin.on('error', finish);
    stdin.resume();
  });
}
