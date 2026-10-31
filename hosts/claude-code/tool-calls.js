// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// Claude Code's tool calls as its hooks module hands them over: `call` is the `tool.call` event (the tool's name in
// `tool`, its input beside it) and `result` what the call resolved to.

export const EDIT_TOOL_NAMES = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Claude Code runs commands through Bash, or PowerShell on Windows.
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const PATH_KEYS = ['file_path', 'notebook_path', 'path'];
const LABEL_MAX_CHARS = 80;

import { identifiersAddedBy } from '../../lib/stuck-query.js';

const text = (value) => (typeof value === 'string' ? value : '');

export const editedPath = (call) => text(call?.file_path) || text(call?.notebook_path);

const lineCount = (value) => (text(value) ? value.split('\n').length : 0);

/** Lines an edit touched, removed plus written: the blast radius the turn summary's saving is sized by. */
export function changedLinesOf(call) {
  const edits = Array.isArray(call?.edits) ? call.edits : [call];
  return edits.reduce((total, edit) => total + lineCount(edit?.old_string) + lineCount(edit?.new_string ?? edit?.content ?? edit?.new_source), 0);
}

/** Identifiers an edit call introduced, across every edit a MultiEdit carries. */
export function addedIdentifiersOf(call) {
  const edits = Array.isArray(call?.edits) ? call.edits : [call];
  return [...new Set(edits.flatMap((edit) => identifiersAddedBy(edit?.old_string, edit?.new_string ?? edit?.content ?? edit?.new_source)))];
}

/**
 * How a check is named to the person: the one-line description the model gave the shell call, else the command's
 * first line, since the desktop notice draws no line breaks.
 */
export function checkLabelOf(call) {
  const firstLine = text(call?.command).split('\n').find((line) => line.trim()) ?? '';
  const label = (text(call?.description).trim() || firstLine).replace(/\s+/g, ' ').trim();
  return label.length > LABEL_MAX_CHARS ? `${label.slice(0, LABEL_MAX_CHARS - 1)}…` : label;
}

/** The files an edit call is about to change, for the hash taken before it runs. */
export const editedFilesOf = ({ call }) => (EDIT_TOOL_NAMES.includes(call?.tool) && editedPath(call) ? [editedPath(call)] : []);

/**
 * What one finished call says the turn did. A denied call never ran; a background run has not finished when its
 * call returns, so it is a command with no verdict yet.
 */
export function toolNoteOf({ call, result }) {
  if (!call || result?.denied) return null;
  const command = text(call.command);
  if (SHELL_TOOLS.has(call.tool) && command && !call.run_in_background) {
    return { kind: 'shell', command, exit: result?.isError ? 1 : 0, output: text(result?.text), label: checkLabelOf(call) };
  }
  if (EDIT_TOOL_NAMES.includes(call.tool) && editedPath(call)) {
    if (result?.isError) return null;
    const identifiers = addedIdentifiersOf(call);
    return { kind: 'edit', paths: [editedPath(call)], lines: changedLinesOf(call), ...(identifiers.length > 0 && { identifiers }) };
  }
  const paths = PATH_KEYS.map((key) => text(call[key])).filter(Boolean);
  return command || paths.length > 0 ? { kind: 'tool', ...(command && { command }), paths } : null;
}
