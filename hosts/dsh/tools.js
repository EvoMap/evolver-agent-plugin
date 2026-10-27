// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import path from 'node:path';

import { isVerificationCommand } from '../../lib/verification.js';

const SHELL_TOOLS = new Set(['bash', 'pwsh']);
const EDIT_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);
const EDITOR_VIEW = 'view';
const PATH_KEYS = ['file_path', 'path'];
// A run that its timeout or a signal killed has no exit code; `timeout(1)` reports the same end as 124.
const KILLED_EXIT = 124;
const EXIT_MARKER = /\[(?:exit code: |Command finished with exit code |shell exited: code )(\d+)\]/g;
const KILLED_MARKER = /\[(?:timed out after \d+ms|(?:shell )?killed by signal: [^\]]+)\]/;

const textOf = (result) => (result?.content ?? [])
  .filter((block) => block?.type === 'text' && typeof block.text === 'string')
  .map((block) => block.text)
  .join('\n');

function exitInText(text) {
  const last = [...text.matchAll(EXIT_MARKER)].at(-1);
  if (last) return Number(last[1]);
  return KILLED_MARKER.test(text) ? KILLED_EXIT : 0;
}

// A call dsh refused or aborted, a run still going in the background, or one stopped on request has no verdict,
// as a check that never finished has none.
function exitOf(result) {
  if (!result || result.isError) return undefined;
  const { value } = result;
  if (value?.kind === 'foreground') {
    if (value.aborted || value.stopped !== undefined) return undefined;
    return Number.isInteger(value.exitCode) ? value.exitCode : KILLED_EXIT;
  }
  if (value?.kind) return undefined;
  return exitInText(typeof value === 'string' ? value : textOf(result));
}

function shellNote(command, result) {
  const exit = exitOf(result);
  if (exit === undefined) return { kind: 'shell', command, running: true };
  const note = { kind: 'shell', command, exit };
  return isVerificationCommand(command) ? { ...note, output: textOf(result) } : note;
}

const isEdit = (name, args) => EDIT_TOOLS.has(name) && !(name === 'str_replace_editor' && args?.command === EDITOR_VIEW);

const pathsOf = (args) => [...new Set(PATH_KEYS.map((key) => args?.[key]).filter((value) => typeof value === 'string' && value))];

export function toolNoteOf({ name, arguments: args, result }) {
  if (SHELL_TOOLS.has(name) && typeof args?.command === 'string') return shellNote(args.command, result);
  const paths = pathsOf(args);
  if (paths.length === 0) return null;
  return isEdit(name, args) && !result?.isError ? { kind: 'edit', paths } : { kind: 'tool', paths };
}

export function editedFilesOf({ name, arguments: args, cwd }) {
  if (!isEdit(name, args) || !cwd) return [];
  return pathsOf(args).map((file) => path.resolve(cwd, file));
}
