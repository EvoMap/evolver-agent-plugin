// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import path from 'node:path';

// Qoder CLI hands a finished Bash call to PostToolUse as `{ kind, stdout, stderr, exitCode }` and a failed one to
// PostToolUseFailure as `error: "Exit code N\n<output>"`; a call that never ran fails with no exit code.

export const SHELL_TOOLS = Object.freeze(['Bash', 'PowerShell']);
export const EDIT_TOOLS = Object.freeze(['Write', 'Edit', 'NotebookEdit']);

const FAILURE_EVENT = 'PostToolUseFailure';
const EXIT_LINE = /^Exit code (-?\d+)(?:\n|$)/;
const BACKGROUNDED = 'backgrounded';

const text = (value) => (typeof value === 'string' ? value : '');

const editedPathOf = (input) => text(input?.file_path) || text(input?.notebook_path);

const lineCount = (value) => (text(value) ? value.split('\n').length : 0);

/** Lines an edit touched, removed plus written, as its input states them. */
const changedLinesOf = (input) => lineCount(input?.old_string) + lineCount(input?.new_string ?? input?.content ?? input?.new_source);

function finishedShellNote(command, response, callId) {
  if (typeof response === 'string') return { kind: 'shell', command, exit: null, output: response };
  if (response?.kind === BACKGROUNDED) return { kind: 'shell', command, running: true, callId };
  const exit = Number.isInteger(response?.exitCode) ? response.exitCode : null;
  return { kind: 'shell', command, exit, output: `${text(response?.stdout)}${response?.stderr ? `\n${response.stderr}` : ''}` };
}

function failedShellNote(command, error) {
  const exit = EXIT_LINE.exec(text(error));
  return exit ? { kind: 'shell', command, exit: Number(exit[1]), output: text(error).slice(exit[0].length) } : { kind: 'tool', command };
}

function editNoteOf(input, hasFailed) {
  const file = editedPathOf(input);
  if (!file) return null;
  return hasFailed ? { kind: 'tool', paths: [file] } : { kind: 'edit', paths: [file], lines: changedLinesOf(input) };
}

/** What one Bash, PowerShell or edit call did, from its PostToolUse or PostToolUseFailure payload; null for others. */
export function toolNoteOf(payload, context) {
  const hasFailed = (context?.hostEvent ?? payload.hook_event_name) === FAILURE_EVENT;
  const { tool_name: name, tool_input: input } = payload;
  if (EDIT_TOOLS.includes(name)) return editNoteOf(input, hasFailed);
  const command = text(input?.command);
  if (!SHELL_TOOLS.includes(name) || !command) return null;
  return hasFailed ? failedShellNote(command, payload.error) : finishedShellNote(command, payload.tool_response, text(payload.tool_use_id));
}

/** The file a Write, Edit or NotebookEdit is about to change, absolute, from its PreToolUse payload. */
export function editedFilesOf({ tool_name: name, tool_input: input, cwd }) {
  const file = EDIT_TOOLS.includes(name) ? editedPathOf(input) : '';
  if (!file) return [];
  if (path.isAbsolute(file)) return [file];
  return path.isAbsolute(text(cwd)) ? [path.join(cwd, file)] : [];
}
