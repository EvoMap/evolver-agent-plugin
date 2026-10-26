// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import path from 'node:path';

import { isVerificationCommand } from '../../lib/verification.js';

// What one OpenCode tool call did, from `tool.execute.after`, which fires only for a call that ran to its end:
// one the person denied, or that threw, never reaches it, so a check that was not allowed to run is no failed one.

export const EDIT_TOOLS = new Set(['write', 'edit', 'apply_patch']);
const SHELL_TOOL = 'bash';
const PATH_KEYS = ['filePath', 'path'];
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/;
const USER_ABORTED = 'User aborted the command';
// The bash tool reports a run its timeout killed with no exit code; `timeout(1)` reports the same end as 124.
const TIMED_OUT_EXIT = 124;

function patchedPaths(patch) {
  const paths = [];
  for (const line of patch.split('\n')) {
    const match = PATCH_FILE.exec(line.trimEnd());
    const file = (match?.[1] ?? match?.[2])?.trim();
    if (file && !paths.includes(file)) paths.push(file);
  }
  return paths;
}

/** The files a tool call names: the one it reads or writes, or every file an `apply_patch` touches. */
export function touchedPaths(args) {
  if (typeof args?.patchText === 'string') return patchedPaths(args.patchText);
  return PATH_KEYS.filter((key) => typeof args?.[key] === 'string' && args[key]).map((key) => args[key]);
}

// A check the person interrupted never finished, so it has no verdict, as a run still going at turn end has none.
function shellNote(command, { output = '', metadata } = {}) {
  const exit = metadata?.exit;
  const text = String(output ?? '');
  if (exit === null && text.includes(USER_ABORTED)) return { kind: 'shell', command, running: true };
  const note = { kind: 'shell', command, exit: exit === null ? TIMED_OUT_EXIT : exit };
  return isVerificationCommand(command) ? { ...note, output: text } : note;
}

/** The TurnNote of a finished call: `{ tool, args, result: { output, metadata } }`. */
export function toolNoteOf({ tool, args, result }) {
  if (tool === SHELL_TOOL && typeof args?.command === 'string') return shellNote(args.command, result);
  const paths = touchedPaths(args);
  if (EDIT_TOOLS.has(tool)) return paths.length > 0 ? { kind: 'edit', paths } : null;
  const command = typeof args?.command === 'string' && args.command ? args.command : undefined;
  return command || paths.length > 0 ? { kind: 'tool', ...(command && { command }), paths } : null;
}

/** The file an edit tool is about to change, from `tool.execute.before`, resolved against the project. */
export function editedFileOf({ tool, args, directory }) {
  if (!EDIT_TOOLS.has(tool)) return null;
  const [file] = touchedPaths(args);
  return file && directory ? path.resolve(directory, file) : null;
}
