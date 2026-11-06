// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import path from 'node:path';

const EDITS = new Set(['edit', 'write']);
const text = value => typeof value === 'string' ? value : '';
const inputPath = input => text(input?.file_path) || text(input?.path);
const lines = value => text(value) ? value.split('\n').length : 0;

export function editedFilesOf({ tool_name: name, tool_input: input, cwd }) {
  const file = EDITS.has(name) ? inputPath(input) : '';
  if (!file) return [];
  return path.isAbsolute(file) ? [file] : path.isAbsolute(text(cwd)) ? [path.resolve(cwd, file)] : [];
}

export function toolNoteOf(payload) {
  const { tool_name: name, tool_input: input, tool_response: response } = payload;
  const details = response?.details;
  if (EDITS.has(name)) {
    const paths = editedFilesOf(payload);
    if (!paths.length) return null;
    if (response?.isError || response?.is_error || details?.is_error || ['failed', 'cancelled'].includes(details?.status)) return { kind: 'tool', paths };
    return { kind: 'edit', paths, lines: lines(input.old_string) + lines(input.new_string ?? input.content) };
  }
  if (name !== 'bash' || !text(input?.command)) return null;
  const command = input.command;
  const execution = details?.execution;
  if (execution?.reason !== 'exited' || !Number.isInteger(execution.exitCode) || details?.processOutput?.interrupted) return { kind: 'tool', command };
  const output = details?.processOutput;
  return { kind: 'shell', command, exit: execution.exitCode, output: output ? `${text(output.stdout)}${output.stderr ? `\n${output.stderr}` : ''}` : (response.content ?? []).filter(part => part.type === 'text').map(part => text(part.text)).join('\n') };
}
