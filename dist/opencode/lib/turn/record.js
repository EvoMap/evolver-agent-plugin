// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { isVerificationCommand, verificationFailed } from '../verification.js';

const CHECK_COMMAND_MAX_CHARS = 200;

/**
 * What a turn did, from the tool notes a host adapter wrote as each call finished:
 *   { kind: 'shell', command, exit?: number | null, output?: string, running?: true, callId?, label? }
 *   { kind: 'edit', paths, lines?, identifiers? }
 *   { kind: 'tool', command?, paths? }
 *   { kind: 'answer', text }        the turn's final answer, for a host that tells it before the turn's end
 * An exit code decides a check when the host gives one; the output is read too, since a failing run piped
 * through `tail` still exits zero. A command still running has no verdict: a later note with its `callId`
 * settles it, and one still pending when the turn ends counts as not run. `label` names a check to the person, and
 * `lines` counts what an edit changed and `identifiers` the names it introduced, where the host says.
 */
export function turnRecordOf(notes) {
  const record = { checks: [], commands: [], paths: [], edits: [], identifiers: [], changedLines: 0, answer: '' };
  const pending = new Set();
  for (const note of notes ?? []) {
    if (note.kind === 'answer') {
      record.answer = String(note.text ?? '');
      continue;
    }
    const isCompletion = Boolean(note.callId) && pending.has(note.callId);
    if (isCompletion) pending.delete(note.callId);
    if (typeof note.command === 'string' && note.command && !isCompletion) record.commands.push(note.command);
    record.paths.push(...(note.paths ?? []).filter((file) => typeof file === 'string' && file));
    if (note.kind === 'edit') {
      record.edits.push(...(note.paths ?? []));
      record.identifiers.push(...(note.identifiers ?? []).filter((name) => typeof name === 'string'));
      record.changedLines += Number(note.lines) || 0;
    }
    if (note.kind !== 'shell' || !isVerificationCommand(note.command)) continue;
    if (note.running) {
      if (note.callId) pending.add(note.callId);
      continue;
    }
    record.checks.push({ command: note.command.slice(0, CHECK_COMMAND_MAX_CHARS), failed: checkFailed(note), ...(note.label && { label: note.label }) });
  }
  return record;
}

function checkFailed(note) {
  const isError = Number.isInteger(note.exit) && note.exit !== 0;
  return verificationFailed({ isError, text: note.output ?? '' });
}

/** Whether a tool note is a finished test, build, lint or type-check that failed. */
export function isFailedCheck(note) {
  return note?.kind === 'shell' && !note.running && isVerificationCommand(note.command) && checkFailed(note);
}
