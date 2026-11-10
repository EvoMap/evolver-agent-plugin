// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_INDEX = 1024 * 1024;
const MAX_BATCH = 4 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function isSameDirectory(candidate, directory) {
  try {
    return typeof candidate === 'string' && realpathSync(candidate) === directory;
  } catch {
    return false;
  }
}

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

function jsonOf(root, file, maximum) {
  const safe = confined(root, file);
  const before = statSync(safe);
  const fd = openSync(safe, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('rotated');
    if (stat.size > maximum) throw new Error('oversize');
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    let read;
    do {
      read = readSync(fd, buffer, size, buffer.length - size, null);
      size += read;
    } while (read && size < buffer.length);
    if (size > maximum) throw new Error('oversize');
    return JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

function recordsOf(root, file, after) {
  const safe = confined(root, file);
  const stat = statSync(safe);
  const fileId = `${stat.dev}:${stat.ino}`;
  const offset = after?.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size || (after?.fileId && after.fileId !== fileId)) {
    throw new Error('rotated');
  }
  const length = Math.min(MAX_BATCH, stat.size - offset);
  const buffer = Buffer.alloc(length);
  let fd;
  let size = 0;
  try {
    fd = openSync(safe, 'r');
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('rotated');
    while (size < length) {
      const read = readSync(fd, buffer, size, length - size, offset + size);
      if (!read) break;
      size += read;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const records = []; let start = 0;
  const content = buffer.subarray(0, size);
  for (let end = content.indexOf(10); end >= 0; end = content.indexOf(10, start)) {
    const line = buffer.subarray(start, end).toString('utf8');
    if (line.trim()) {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
      Object.defineProperty(value, '$offset', { value: offset + start });
      records.push(value);
    }
    start = end + 1;
  }
  return {
    records,
    mark: { offset: offset + start, fileId },
    incompleteTail: start < size,
    limited: stat.size - offset > MAX_BATCH || (size === MAX_BATCH && start < size),
  };
}

/**
 * Read-only native facts over a host's indexed session log. The declaration names the index file, lists its
 * workspaces as `[id, root]` (`workspacesOf`, null for an unsupported index), and places a workspace's session folder
 * (`sessionDir(workspaceId, sessionId)`) and its JSONL log (`logFile`) under its root. A failed read is never an
 * empty valid turn.
 */
export function nativeFactsOf(declaration, env = process.env) {
  if (!declaration) return null;
  let scopedRoot = resolve(declaration.root(env));
  // A fresh native profile may not exist yet.
  try {
    scopedRoot = realpathSync(scopedRoot);
  } catch {}
  const scope = createHash('sha256').update(scopedRoot).digest('hex');
  return { scope, reference: declaration.reference, read(payload, context = {}) {
    try {
      const root = realpathSync(declaration.root(env));
      const sessionId = declaration.sessionId(payload);
      const projectDir = realpathSync(declaration.projectDir(payload));
      if (!ID.test(sessionId)) return { status: 'unsupported' };
      const listed = declaration.workspacesOf(jsonOf(root, join(root, declaration.workspaceIndex), MAX_INDEX));
      if (!Array.isArray(listed)) return { status: 'unsupported' };
      const workspaces = listed.filter(
        ([id, workspaceRoot]) => ID.test(id) && isSameDirectory(workspaceRoot, projectDir),
      );
      if (workspaces.length !== 1) return { status: 'missing' };
      const sessionDir = join(root, declaration.sessionDir(workspaces[0][0], sessionId));
      const wire = join(sessionDir, declaration.logFile);
      const batch = recordsOf(root, wire, context.after);
      const ids = declaration.taskIds?.(batch.records, payload) ?? [];
      if (!Array.isArray(ids) || ids.length > 64 || ids.some((id) => !ID.test(id))) {
        return { status: 'partial', mark: batch.mark };
      }
      const tasks = [];
      const taskRoot = declaration.tasksRoot?.(env, sessionDir);
      let budget = MAX_BATCH;
      for (const id of new Set(ids)) {
        if (!taskRoot) break;
        try {
          const file = confined(root, join(taskRoot, `${id}.json`));
          const size = statSync(file).size;
          if (size > MAX_INDEX || size > budget) return { status: 'partial', mark: batch.mark };
          budget -= size;
          const task = jsonOf(root, file, size);
          if (task?.taskId !== id) return { status: 'partial', mark: batch.mark };
          tasks.push(task);
        } catch (error) {
          if (error?.code !== 'ENOENT') return { status: 'partial', mark: batch.mark };
        }
      }
      const decoded = declaration.decode(batch.records, tasks, payload, { ...context, projectDir });
      return {
        ...decoded,
        records: batch.records,
        tasks,
        mark: batch.mark,
        incompleteTail: batch.incompleteTail,
        limited: batch.limited,
        status: batch.limited || batch.incompleteTail ? 'partial' : decoded.status ?? 'ok',
      };
    } catch (error) {
      return {
        status: error?.code === 'ENOENT'
          ? 'missing'
          : error?.message === 'oversize' || error?.message === 'rotated' ? 'partial' : 'unreadable',
      };
    }

  } };
}
