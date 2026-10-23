// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PROXY_PORT, proxyResultOf, proxySettingsFrom, timedOutResult, unreachableResult } from '../proxy-response.js';
import { EMPTY_STATE } from './turns.js';

const PROXY_TIMEOUT_MS = 8_000;
const STDIN_WAIT_MS = 1_000;
const MAX_TRANSCRIPT_CHUNK_BYTES = 4 * 1024 * 1024;
const SESSION_FILE = /^session-(.+)\.json$/;

const safeName = (sessionId) => String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 160);

export function stateDirOf(env, host) {
  return env.PLUGIN_DATA || join(env.HOME || env.USERPROFILE || homedir(), '.evolver', 'agent-plugin', host);
}

// One file per session, replaced whole through a rename, so a hook that dies
// mid-write leaves the previous state rather than half of the next one.
export function sessionFile(dir, sessionId) {
  const path = join(dir, `session-${safeName(sessionId)}.json`);
  return {
    readState() {
      try {
        return { ...EMPTY_STATE, ...JSON.parse(readFileSync(path, 'utf8')) };
      } catch {
        return { ...EMPTY_STATE };
      }
    },
    writeState(state) {
      mkdirSync(dir, { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(state));
      renameSync(temp, path);
    },
    remove() {
      rmSync(path, { force: true });
    },
  };
}

export function otherSessionFiles(dir, sessionId) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const own = `session-${safeName(sessionId)}.json`;
  return names.filter((name) => SESSION_FILE.test(name) && name !== own).map((name) => sessionFile(dir, SESSION_FILE.exec(name)[1]));
}

export function proxyFetchFrom(env, port) {
  return async (method, path, body) => {
    const home = env.HOME || env.USERPROFILE || '';
    let settingsText = '';
    try {
      settingsText = home ? readFileSync(join(home, '.evolver', 'settings.json'), 'utf8') : '';
    } catch {
    }
    const { url: base, token } = proxySettingsFrom(settingsText, port || env.EVOMAP_PROXY_PORT || DEFAULT_PROXY_PORT);
    const headers = { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) };
    try {
      const response = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });
      return proxyResultOf({ ok: response.ok, status: response.status, text: await response.text() }, base, token);
    } catch (error) {
      return error?.name === 'TimeoutError' ? timedOutResult(base, PROXY_TIMEOUT_MS) : unreachableResult(base, error);
    }
  };
}

export function transcriptSizeOf(path) {
  try {
    return typeof path === 'string' && path ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

export function transcriptChunkFrom(path, offset) {
  if (typeof path !== 'string' || !path) return '';
  let fd;
  try {
    const size = statSync(path).size;
    const start = Number.isInteger(offset) && offset >= 0 && offset <= size ? offset : 0;
    const length = Math.min(size - start, MAX_TRANSCRIPT_CHUNK_BYTES);
    if (length <= 0) return '';
    const buffer = Buffer.alloc(length);
    fd = openSync(path, 'r');
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Some hosts never close a hook's stdin; the input is taken once it parses,
// or whatever arrived when the wait runs out.
export function readHookInput(stream = process.stdin, waitMs = STDIN_WAIT_MS) {
  return new Promise((resolve) => {
    let text = '';
    const finish = () => {
      clearTimeout(timer);
      stream.removeAllListeners('data');
      stream.pause();
      try {
        resolve(text.trim() ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(finish, waitMs);
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      text += chunk;
      try {
        JSON.parse(text);
        finish();
      } catch {
      }
    });
    stream.on('end', finish);
    stream.on('error', finish);
  });
}
