// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { isVerificationCommand, verificationFailed } from '../verification.js';

const CHECK_COMMAND_MAX_CHARS = 200;

/**
 * What a turn did, from the tool notes a host adapter wrote as each call finished:
 *   { kind: 'shell', command, exit?: number | null, output?: string, running?: true, callId? }
 *   { kind: 'edit', paths }
 *   { kind: 'tool', command?, paths? }
 * An exit code decides a check when the host gives one; the output is read too, since a failing run piped
 * through `tail` still exits zero. A command still running has no verdict: a later note with its `callId`
 * settles it, and one still pending when the turn ends counts as not run.
 */
export function turnRecordOf(notes) {
  const record = { checks: [], commands: [], paths: [], edits: [], answer: '' };
  const pending = new Set();
  for (const note of notes ?? []) {
    const isCompletion = Boolean(note.callId) && pending.has(note.callId);
    if (isCompletion) pending.delete(note.callId);
    if (typeof note.command === 'string' && note.command && !isCompletion) record.commands.push(note.command);
    record.paths.push(...(note.paths ?? []).filter((file) => typeof file === 'string' && file));
    if (note.kind === 'edit') record.edits.push(...(note.paths ?? []));
    if (note.kind !== 'shell' || !isVerificationCommand(note.command)) continue;
    if (note.running) {
      if (note.callId) pending.add(note.callId);
      continue;
    }
    const isError = Number.isInteger(note.exit) && note.exit !== 0;
    record.checks.push({ command: note.command.slice(0, CHECK_COMMAND_MAX_CHARS), failed: verificationFailed({ isError, text: note.output ?? '' }) });
  }
  return record;
}
