// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_INDEX = 1024 * 1024;
const MAX_HEAD = 64 * 1024;
const MAX_TAIL = 4 * 1024 * 1024;
const MAX_TASKS = 64;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function confined(root, file) {
  const candidate = resolve(file);
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('unsafe');
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('unsafe');
  }
  const actual = realpathSync(candidate);
  const back = relative(root, actual);
  if (!back || back.startsWith('..') || isAbsolute(back) || !statSync(actual).isFile()) throw new Error('unsafe');
  return actual;
}

function bytesOf(fd, offset, length) {
  const buffer = Buffer.alloc(length);
  let size = 0;
  while (size < length) {
    const read = readSync(fd, buffer, size, length - size, offset + size);
    if (!read) break;
    size += read;
  }
  return buffer.subarray(0, size);
}

function jsonOf(root, file, maximum) {
  const fd = openSync(confined(root, file), 'r');
  try {
    const { size } = fstatSync(fd);
    if (size > maximum) throw new Error('oversize');
    return JSON.parse(bytesOf(fd, 0, size).toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

// Only whole lines count: a line still being written, or one cut by the window's start, is no record yet.
function linesOf(bytes, offset, { skipFirst }) {
  const records = [];
  let start = 0;
  if (skipFirst) start = bytes.indexOf(10) + 1 || bytes.length;
  for (let end = bytes.indexOf(10, start); end >= 0; end = bytes.indexOf(10, start)) {
    const line = bytes.subarray(start, end).toString('utf8');
    if (line.trim()) {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
      Object.defineProperty(value, '$offset', { value: offset + start });
      records.push(value);
    }
    start = end + 1;
  }
  return records;
}

// A long session's log is read as its head (the header) and its tail (recent turns), so a poll costs a bounded read.
// The tail starts one byte early: a window that opens on a line start keeps that line.
function recordsOf(fd, size) {
  const tailStart = Math.max(0, size - MAX_TAIL - 1);
  const tail = linesOf(bytesOf(fd, tailStart, size - tailStart), tailStart, { skipFirst: tailStart > 0 });
  if (tailStart === 0) return tail;
  const firstTail = tail[0]?.$offset ?? size;
  const head = linesOf(bytesOf(fd, 0, Math.min(MAX_HEAD, size)), 0, { skipFirst: false });
  return [...head.filter((record) => record.$offset < firstTail), ...tail];
}

function tasksOf(root, dir, named) {
  const ids = [...new Set(named)];
  if (!dir || ids.length === 0) return [];
  if (ids.length > MAX_TASKS || ids.some((id) => !ID.test(id))) return null;
  const tasks = [];
  for (const id of ids) {
    try {
      const task = jsonOf(root, join(dir, `${id}.json`), MAX_INDEX);
      if (task?.taskId !== id) return null;
      tasks.push(task);
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
    }
  }
  return tasks;
}

function sessionDirOf(declaration, home, nativeId) {
  const listed = declaration.workspacesOf(jsonOf(home, join(home, declaration.workspaceIndex), MAX_INDEX));
  if (!Array.isArray(listed)) return null;
  const found = listed.filter(([id]) => ID.test(id)).flatMap(([id, projectDir]) => {
    const dir = join(home, declaration.sessionDir(id, nativeId));
    try {
      confined(home, join(dir, declaration.logFile));
      return [{ dir, projectDir }];
    } catch {
      return [];
    }
  });
  return found.length === 1 ? found[0] : null;
}

/**
 * A turn's status read from a host's own JSONL session log, for a host whose evidence is only there. The declaration
 * names the log home (`root(env)`), its workspace index (`workspaceIndex`, listed as `[id, projectDir]` by
 * `workspacesOf`), a session's folder in a workspace (`sessionDir(workspaceId, nativeId)`) and its log (`logFile`);
 * `nativeSessionOf(sessionId, scope)` takes the plugin's session id back to the host's. `decode(records, { turnId,
 * tasks, projectDir })` answers the row; `taskIds(records)` and `tasksDir(sessionDir)` name the background task files
 * it also reads. `scope` is a pseudonym of the log home, for session ids, so no path reaches a Hub task id. Anything
 * unreadable answers null, never an empty valid turn.
 */
export function sessionLogReaderOf(declaration, env = process.env) {
  if (!declaration) return undefined;
  let home = resolve(declaration.root(env));
  try {
    home = realpathSync(home);
  } catch {}
  const scopeOf = (path) => createHash('sha256').update(path).digest('hex');
  const scope = scopeOf(home);
  let parsed = null;
  const read = (sessionId, turnId) => {
    if (typeof sessionId !== 'string' || typeof turnId !== 'string' || !turnId || turnId.length > 256) return null;
    let fd;
    try {
      const root = realpathSync(declaration.root(env));
      if (scopeOf(root) !== scope) return null;
      const nativeId = declaration.nativeSessionOf(sessionId, scope);
      if (!ID.test(nativeId ?? '')) return null;
      const session = sessionDirOf(declaration, root, nativeId);
      if (!session) return null;
      fd = openSync(confined(root, join(session.dir, declaration.logFile)), 'r');
      const stat = fstatSync(fd);
      const key = JSON.stringify([session.dir, stat.dev, stat.ino, stat.size, stat.mtimeMs]);
      if (parsed?.key !== key) parsed = { key, records: recordsOf(fd, stat.size) };
      const { records } = parsed;
      const tasks = tasksOf(root, declaration.tasksDir?.(session.dir), declaration.taskIds?.(records) ?? []);
      if (!tasks) return null;
      return declaration.decode(records, { turnId, tasks, projectDir: session.projectDir }) ?? null;
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  return Object.assign(read, { scope });
}
