// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// Claude Code's tool calls as its hooks module hands them over: `call` is the `tool.call` event (the tool's name in
// `tool`, its input beside it) and `result` what the call resolved to.

export const EDIT_TOOL_NAMES = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Claude Code runs commands through Bash, or PowerShell on Windows.
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const PATH_KEYS = ['file_path', 'notebook_path', 'path'];

const text = (value) => (typeof value === 'string' ? value : '');

export const editedPath = (call) => text(call?.file_path) || text(call?.notebook_path);

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
    return { kind: 'shell', command, exit: result?.isError ? 1 : 0, output: text(result?.text) };
  }
  if (EDIT_TOOL_NAMES.includes(call.tool) && editedPath(call)) {
    return result?.isError ? null : { kind: 'edit', paths: [editedPath(call)] };
  }
  const paths = PATH_KEYS.map((key) => text(call[key])).filter(Boolean);
  return command || paths.length > 0 ? { kind: 'tool', ...(command && { command }), paths } : null;
}
