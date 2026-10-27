// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import path from 'node:path';

import { isVerificationCommand } from '../../lib/verification.js';

export const SHELL_TOOL = 'Bash';
export const PATCH_TOOL = 'apply_patch';

const FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/;
const EMBEDDED_PATCH = /^\*\*\* Begin Patch$[\s\S]*?^\*\*\* End Patch$/m;
const APPLIED = /^Exit code: 0\b|^Success\./m;
const OUTPUT_MARKER = /^Output:$/m;
const EXIT_HEADER = /^(?:Exit code: |Process exited with code )(-?\d+)$/m;
const STILL_RUNNING = /^Process running with session ID \d+$/m;
const TIMED_OUT = /^command timed out after \d+ milliseconds\n/;
const FAILED_WITHOUT_CODE = 1;

const text = (value) => (typeof value === 'string' ? value : '');

/** The patch a call applies: apply_patch's own input, or one a Bash command feeds to `apply_patch <<'PATCH'`. */
function patchOf(toolName, command) {
  if (typeof command !== 'string') return null;
  if (toolName === PATCH_TOOL) return command;
  return EMBEDDED_PATCH.exec(command)?.[0] ?? null;
}

/** Every file a patch adds, updates, deletes or moves to, as the patch names it (relative to the session's cwd). */
export function patchedPaths(patch) {
  const paths = [];
  for (const line of String(patch ?? '').split('\n')) {
    const match = FILE_HEADER.exec(line.trimEnd());
    const file = (match?.[1] ?? match?.[2])?.trim();
    if (file && !paths.includes(file)) paths.push(file);
  }
  return paths;
}

const patchApplied = (response) => APPLIED.test(text(response));

function headerOf(output) {
  const marker = OUTPUT_MARKER.exec(output);
  return marker ? output.slice(0, marker.index) : '';
}

/**
 * A Bash result as PostToolUse hands it over. Codex gives the bare output, without the exit code the model sees, so
 * a check is judged by its output; an `Exit code:` or `Process exited with code` header, where one comes along,
 * decides, and a timed-out run failed. A run still going at its wait limit has no verdict until its completion.
 */
function shellNoteOf(command, output, callId) {
  const ids = callId ? { callId } : {};
  const header = headerOf(output);
  if (STILL_RUNNING.test(header)) return { kind: 'shell', command, running: true, ...ids };
  const exit = EXIT_HEADER.exec(header);
  if (exit) return { kind: 'shell', command, exit: Number(exit[1]), output: output.slice(OUTPUT_MARKER.exec(output).index), ...ids };
  return { kind: 'shell', command, exit: TIMED_OUT.test(output) ? FAILED_WITHOUT_CODE : null, output, ...ids };
}

// A command that both applies a patch and runs a check is kept as the check: its verdict outweighs the edit.
function bashNoteOf({ tool_input: input, tool_response: response, tool_use_id: callId }) {
  const command = text(input?.command);
  if (!command) return null;
  const patch = patchOf(SHELL_TOOL, command);
  const paths = patchedPaths(patch);
  if (patch && !isVerificationCommand(command)) return { kind: patchApplied(response) ? 'edit' : 'tool', command, paths };
  return { ...shellNoteOf(command, text(response), text(callId)), ...(paths.length > 0 && { paths }) };
}

function patchNoteOf({ tool_input: input, tool_response: response }) {
  const paths = patchedPaths(patchOf(PATCH_TOOL, input?.command));
  return { kind: patchApplied(response) ? 'edit' : 'tool', paths };
}

const NOTES = { [SHELL_TOOL]: bashNoteOf, [PATCH_TOOL]: patchNoteOf };

/** What one Bash or apply_patch call did, from its PostToolUse payload; null for any other tool. */
export const toolNoteOf = (payload) => NOTES[payload.tool_name]?.(payload) ?? null;

const absoluteIn = (cwd, file) => {
  if (path.isAbsolute(file)) return file;
  return path.isAbsolute(text(cwd)) ? path.join(cwd, file) : null;
};

/** The files a patch is about to change, absolute, from a PreToolUse of apply_patch or of a Bash that runs one. */
export const editedFilesOf = ({ tool_name: name, tool_input: input, cwd }) =>
  patchedPaths(patchOf(name, input?.command)).map((file) => absoluteIn(cwd, file)).filter(Boolean);
