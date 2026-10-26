// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import path from 'node:path';

const SHELL_TOOL = 'Shell';
const DELETE_TOOL = 'Delete';
const EDIT_TOOLS = new Set(['Write', DELETE_TOOL]);
const PATH_KEYS = ['path', 'file_path'];
const NOT_RUN_FAILURES = new Set(['permission_denied']);
// What Cursor's Shell tool says for a result that is neither an exit, a timeout nor a refusal, such as a command
// moved to the background before it finished: no verdict yet.
const UNSETTLED_SHELL_ERROR = 'Unknown error';

const text = (value) => (typeof value === 'string' ? value : '');

function parsedOutput(output) {
  try {
    const parsed = JSON.parse(output);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return { output: text(output) };
  }
}

function baseNoteOf(input) {
  const command = text(input?.command);
  return { kind: 'tool', ...(command && { command }), paths: PATH_KEYS.map((key) => input?.[key]).filter((value) => typeof value === 'string' && value) };
}

/** A tool call that ran, as postToolUse hands it over: Shell's output is `{"output","exitCode"}` as JSON text. */
function toolUseNote({ tool_name: name, tool_input: input, tool_output: output }) {
  const note = baseNoteOf(input);
  if (name === SHELL_TOOL && note.command) {
    const result = parsedOutput(output);
    return { kind: 'shell', command: note.command, exit: Number.isInteger(result.exitCode) ? result.exitCode : null, output: text(result.output) };
  }
  return name === DELETE_TOOL ? { kind: 'edit', paths: note.paths } : note;
}

/**
 * A tool call that failed, as postToolUseFailure hands it over: a Shell command that exited non-zero or timed out
 * failed; one the person interrupted or that went to the background has no verdict, and one denied never ran.
 */
function toolFailureNote({ tool_name: name, tool_input: input, error_message: message, failure_type: type, is_interrupt: interrupted }) {
  if (NOT_RUN_FAILURES.has(type)) return null;
  const note = baseNoteOf(input);
  if (name !== SHELL_TOOL || !note.command || interrupted || message === UNSETTLED_SHELL_ERROR) return note;
  return { kind: 'shell', command: note.command, exit: 1, output: text(message) };
}

const editNote = ({ file_path: file }) => (text(file) ? { kind: 'edit', paths: [file] } : null);

const answerNote = ({ text: answer }) => (text(answer).trim() ? { kind: 'answer', text: answer.trim() } : null);

const NOTES = { postToolUse: toolUseNote, postToolUseFailure: toolFailureNote, afterFileEdit: editNote, afterAgentResponse: answerNote };

/** What one of Cursor's tool, edit or response hooks says the turn did, by the event the payload names. */
export const toolNoteOf = (payload) => NOTES[payload.hook_event_name]?.(payload) ?? null;

/** The file a Write or Delete is about to change, absolute; preToolUse's matcher sends only those. */
export function editedFileOf({ tool_name: name, tool_input: input, workspace_roots: roots }) {
  const file = EDIT_TOOLS.has(name) ? text(input?.file_path) : '';
  if (!file) return null;
  if (path.isAbsolute(file)) return file;
  const [root] = Array.isArray(roots) ? roots : [];
  return text(root) ? path.join(root, file) : null;
}
