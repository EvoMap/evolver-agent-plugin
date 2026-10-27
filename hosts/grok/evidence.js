// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import path from 'node:path';

// Grok's own tools, and the names its Cursor preset and daemon route give them, with their own input keys.
export const SHELL_TOOLS = Object.freeze(['run_terminal_command', 'Shell']);
export const EDIT_TOOLS = Object.freeze(['search_replace', 'write', 'hashline_edit', 'StrReplace', 'Write', 'EditNotebook', 'Delete']);
export const TASK_OUTPUT_TOOL = 'get_command_or_subagent_output';
const PATH_KEYS = ['file_path', 'path', 'target_notebook'];
const EXIT_LINE = /^exit: (-?\d+)\n?/;
const FAILED_WITHOUT_CODE = 1;
// A call still running at its `block_until_ms` (30 s by default) goes on in the background and is reported as started.
const BACKGROUND_STARTED = 'BackgroundTaskStarted';
const TASK_OUTPUT = 'TaskOutput';
const STILL_RUNNING = 'running';

const text = (value) => (typeof value === 'string' ? value : '');

const absoluteIn = (cwd, file) => {
  if (!file || path.isAbsolute(file)) return file || null;
  return path.isAbsolute(text(cwd)) ? path.join(cwd, file) : null;
};

/** The file an edit tool names, absolute against the event's cwd, in either tool shape. */
const editedFileIn = ({ toolInput: input, cwd }) => absoluteIn(cwd, PATH_KEYS.map((key) => text(input?.[key])).find(Boolean));

const exitOf = (result) => (Number.isInteger(result?.exit_code) ? result.exit_code : (result?.timed_out ? FAILED_WITHOUT_CODE : null));

/**
 * A shell call's result: grok's `{ type: "Bash", exit_code, output_for_prompt }`, or, past 128 KiB, the text the
 * model reads, which opens with `exit: N`. A call that went on in the background has no verdict yet: its task's
 * output settles it.
 */
function shellNoteOf({ toolInput: input, toolResult: result, toolUseId: callId, isBackgrounded }) {
  const command = text(input?.command);
  if (!command) return null;
  if (result?.type === BACKGROUND_STARTED || isBackgrounded) return { kind: 'shell', command, running: true, callId: text(result?.task_id) || text(callId) };
  const ids = text(callId) ? { callId } : {};
  if (typeof result === 'string') {
    const exit = EXIT_LINE.exec(result);
    return { kind: 'shell', command, exit: exit ? Number(exit[1]) : null, output: result.replace(EXIT_LINE, ''), ...ids };
  }
  return { kind: 'shell', command, exit: exitOf(result), output: text(result?.output_for_prompt).replace(EXIT_LINE, ''), ...ids };
}

/** A background task's output, as get_command_or_subagent_output returns it: the completion of the call that started it. */
function taskOutputNoteOf({ toolResult: result }) {
  const task = result?.type === TASK_OUTPUT ? result.Result : null;
  const command = text(task?.command);
  if (!command || !text(task.task_id)) return null;
  if (task.status === STILL_RUNNING) return { kind: 'shell', command, running: true, callId: task.task_id };
  return { kind: 'shell', command, exit: exitOf(task), output: text(task.output), callId: task.task_id };
}

// grok reports an edit it could not make (`NoMatchesFound`) as a result like any other; another runtime's result has
// its own shape, and PostToolUse fires only for a call that ran.
const isApplied = (result) => (result?.type === 'SearchReplace' ? Boolean(result.EditsApplied) : true);

function editNoteOf(payload) {
  const file = editedFileIn(payload);
  return { kind: isApplied(payload.toolResult) ? 'edit' : 'tool', paths: file ? [file] : [] };
}

/** What one tool call did, from its PostToolUse payload; null for a tool that is neither a shell, a task's output nor an edit. */
export function toolNoteOf(payload) {
  if (SHELL_TOOLS.includes(payload.toolName)) return shellNoteOf(payload);
  if (payload.toolName === TASK_OUTPUT_TOOL) return taskOutputNoteOf(payload);
  return EDIT_TOOLS.includes(payload.toolName) ? editNoteOf(payload) : null;
}

/** The file an edit tool is about to change, absolute against the event's cwd; PreToolUse's matcher sends only those. */
export const editedFileOf = (payload) => (EDIT_TOOLS.includes(payload.toolName) ? editedFileIn(payload) : null);
