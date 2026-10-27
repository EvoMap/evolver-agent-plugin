// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import path from 'node:path';

// Grok's own tools, and the names its Cursor preset and daemon route give them, with their own input keys.
export const SHELL_TOOLS = Object.freeze(['run_terminal_command', 'Shell']);
export const EDIT_TOOLS = Object.freeze(['search_replace', 'write', 'hashline_edit', 'StrReplace', 'Write', 'EditNotebook', 'Delete']);
const PATH_KEYS = ['file_path', 'path', 'target_notebook'];
const EXIT_LINE = /^exit: (-?\d+)\n?/;
const FAILED_WITHOUT_CODE = 1;

const text = (value) => (typeof value === 'string' ? value : '');

const fileOf = (input) => PATH_KEYS.map((key) => text(input?.[key])).find(Boolean) ?? '';

/**
 * A shell call's result: grok's `{ type: "Bash", exit_code, output_for_prompt }`, or, past 128 KiB, the text the
 * model reads, which opens with `exit: N`. A call moved to the background has no verdict yet.
 */
function shellNoteOf({ toolInput: input, toolResult: result, toolUseId: callId, isBackgrounded }) {
  const command = text(input?.command);
  if (!command) return null;
  const ids = text(callId) ? { callId } : {};
  if (isBackgrounded) return { kind: 'shell', command, running: true, ...ids };
  if (typeof result === 'string') {
    const exit = EXIT_LINE.exec(result);
    return { kind: 'shell', command, exit: exit ? Number(exit[1]) : null, output: result.replace(EXIT_LINE, ''), ...ids };
  }
  const exit = Number.isInteger(result?.exit_code) ? result.exit_code : (result?.timed_out ? FAILED_WITHOUT_CODE : null);
  return { kind: 'shell', command, exit, output: text(result?.output_for_prompt).replace(EXIT_LINE, ''), ...ids };
}

// grok reports an edit it could not make (`NoMatchesFound`) as a result like any other; another runtime's result has
// its own shape, and PostToolUse fires only for a call that ran.
const isApplied = (result) => (result?.type === 'SearchReplace' ? Boolean(result.EditsApplied) : true);

function editNoteOf({ toolInput: input, toolResult: result }) {
  const file = fileOf(input);
  return { kind: isApplied(result) ? 'edit' : 'tool', paths: file ? [file] : [] };
}

/** What one tool call did, from its PostToolUse payload; null for a tool that is neither a shell nor an edit. */
export function toolNoteOf(payload) {
  if (SHELL_TOOLS.includes(payload.toolName)) return shellNoteOf(payload);
  return EDIT_TOOLS.includes(payload.toolName) ? editNoteOf(payload) : null;
}

/** The file an edit tool is about to change, absolute against the event's cwd; PreToolUse's matcher sends only those. */
export function editedFileOf({ toolName: name, toolInput: input, cwd }) {
  const file = EDIT_TOOLS.includes(name) ? fileOf(input) : '';
  if (!file) return null;
  if (path.isAbsolute(file)) return file;
  return path.isAbsolute(text(cwd)) ? path.join(cwd, file) : null;
}
