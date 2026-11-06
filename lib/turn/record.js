// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { isVerificationCommand, verificationExitOf, verificationFailureOf } from '../verification.js';

export const CHECK_COMMAND_MAX_CHARS = 2_000;
const OUTPUT_TAIL_MAX_LINES = 20;
const OUTPUT_TAIL_MAX_BYTES = 2 * 1024;

const bytesOf = (text) => new TextEncoder().encode(text).length;

/** The end of a failed check's output, where the failure is named: its last lines, within a couple of KiB. */
function outputTailOf(text) {
  const lines = String(text ?? '').replace(/\s+$/, '').split('\n').slice(-OUTPUT_TAIL_MAX_LINES);
  const tail = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    bytes += bytesOf(lines[index]) + 1;
    if (bytes > OUTPUT_TAIL_MAX_BYTES) break;
    tail.unshift(lines[index]);
  }
  if (tail.length === 0) return lines.at(-1).slice(-OUTPUT_TAIL_MAX_BYTES / 4);
  return tail.join('\n');
}

function checkFailed(note, exit = verificationExitOf(note.command, note.exit)) {
  return note.failed === true || verificationFailureOf({ exit, text: note.output });
}

/** A failed check's step keeps the end of its output, where the failure is named. */
export function checkStepOf(check, output) {
  const tail = check.failed === true ? outputTailOf(output) : '';
  return { kind: 'check', ...check, ...(tail && { output: tail }) };
}

/**
 * What a turn did, from the tool notes a host adapter wrote as each call finished:
 *   { kind: 'shell', command, exit?: number | null, failed?: true, output?: string, running?: true, callId?, label? }
 *   { kind: 'edit', paths, lines?, identifiers? }
 *   { kind: 'tool', command?, paths? }
 *   { kind: 'answer', text }        the turn's final answer, for a host that tells it before the turn's end
 * An exit code decides a check when it can be attributed to that check; a failing run piped through `tail`
 * can still exit zero. Without an attributable exit or a supported passing summary, `failed: null` keeps
 * the check's result unknown, and `failed: true` is a run the host saw fail without giving its code (a timeout, an
 * error step); no exit code is made up for either. A command still running has no verdict: a later note with its `callId`
 * settles it, and one still pending when the turn ends counts as not run. `label` names a check to the person, and
 * `lines` counts what an edit changed and `identifiers` the names it introduced, where the host says. `steps` keeps
 * the commands, checks and edits in the order they happened.
 */
export function turnRecordOf(notes) {
  const record = { checks: [], commands: [], paths: [], edits: [], identifiers: [], changedLines: 0, answer: '', steps: [] };
  const pending = new Set();
  for (const note of notes ?? []) {
    if (note.kind === 'answer') {
      record.answer = String(note.text ?? '');
      continue;
    }
    const isCompletion = Boolean(note.callId) && pending.has(note.callId);
    if (isCompletion) pending.delete(note.callId);
    const isCheck = note.kind === 'shell' && isVerificationCommand(note.command);
    if (typeof note.command === 'string' && note.command && !isCompletion) {
      record.commands.push(note.command);
      if (!isCheck) record.steps.push({ kind: 'command', command: note.command });
    }
    record.paths.push(...(note.paths ?? []).filter((file) => typeof file === 'string' && file));
    if (note.kind === 'edit') noteEdit(record, note);
    if (!isCheck) continue;
    if (note.running) {
      if (note.callId) pending.add(note.callId);
      continue;
    }
    const exit = verificationExitOf(note.command, note.exit) ?? null;
    const check = { command: note.command.slice(0, CHECK_COMMAND_MAX_CHARS), exit, failed: checkFailed(note, exit), ...(note.label && { label: note.label }) };
    record.checks.push(check);
    record.steps.push(checkStepOf(check, note.output));
  }
  return record;
}

function noteEdit(record, note) {
  const paths = (note.paths ?? []).filter((file) => typeof file === 'string' && file);
  record.edits.push(...paths);
  record.steps.push(...paths.map((path) => ({ kind: 'edit', path })));
  record.identifiers.push(...(note.identifiers ?? []).filter((name) => typeof name === 'string'));
  record.changedLines += Number(note.lines) || 0;
}

/** Whether a tool note is a finished test, build, lint or type-check that failed. */
export function isFailedCheck(note) {
  return note?.kind === 'shell' && !note.running && isVerificationCommand(note.command) && checkFailed(note) === true;
}
