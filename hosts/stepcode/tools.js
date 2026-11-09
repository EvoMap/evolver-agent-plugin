// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import { withoutSecrets } from '../../lib/redact.js';

const SHELLS = new Set(['bash', 'run_command']);
const EDITS = new Set(['write', 'edit', 'write_file', 'edit_file']);
const text = (value) => typeof value === 'string' ? value : '';

export function editedFilesOf({ toolName, input, cwd }, { env = {} } = {}) {
  const file = EDITS.has(toolName) ? text(input?.path) : '';
  if (!file.trim()) return [];
  if (file.startsWith('~/') || file.startsWith('~\\')) return [resolve(env.USERPROFILE || env.HOME || homedir(), file.slice(2))];
  return isAbsolute(file) ? [file] : isAbsolute(text(cwd)) ? [resolve(cwd, file)] : [];
}

export function toolNoteOf(payload, context = {}) {
  const { hostEvent } = context;
  const { toolName, toolCallId, input, details, content, isError } = payload;
  if (EDITS.has(toolName)) {
    const paths = editedFilesOf(payload, context);
    if (!paths.length) return null;
    return { kind: isError === true || details?.changed === false ? 'tool' : 'edit', paths };
  }
  if (!SHELLS.has(toolName) || !text(toolCallId).trim() || !text(input?.command).trim()) return null;
  const shell = { kind: 'shell', callId: toolCallId, command: withoutSecrets(input.command) };
  if (hostEvent === 'tool_start') return { ...shell, running: true };
  const execution = details?.execution;
  if (execution?.status === 'running') return { ...shell, running: true };
  const exit = execution?.status === 'exited' && Number.isInteger(execution.exitCode)
    && !(isError === true && execution.exitCode === 0) ? execution.exitCode : null;
  const output = (Array.isArray(content) ? content : []).filter((part) => part?.type === 'text').map((part) => text(part.text)).join('\n');
  // Keep transcript summary fallback from turning missing native metadata into a pass.
  return { ...shell, exit, output: exit === null ? '' : withoutSecrets(output) };
}
