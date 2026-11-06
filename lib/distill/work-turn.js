// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withoutSecrets } from '../redact.js';

// A work turn is what a session accumulates for distillation: a turn that edited files, ran a check, or ran a few
// commands. Reading, searching and answering questions are not work, and neither interrupts the accumulation.
// Keys and tokens are stripped here, before anything is written down or reaches a model or the Proxy.

const MIN_COMMANDS = 3;
const PROMPT_MAX_CHARS = 2_000;
const ANSWER_MAX_CHARS = 2_000;
const CORRECTION_MAX_CHARS = 600;
const COMMAND_MAX_CHARS = 1_000;
const MAX_STEPS = 60;

export const isWorkTurn = (record) => record.edits.length > 0 || record.checks.length > 0 || record.commands.length >= MIN_COMMANDS;

// An agent's report or a host's older record keeps no order between its checks and edits; the edits go before the
// last check, the run that verified them.
function derivedStepsOf(record) {
  const checkCommands = new Set(record.checks.map((check) => check.command));
  const commands = record.commands.filter((command) => !checkCommands.has(command)).map((command) => ({ kind: 'command', command }));
  const checks = record.checks.map((check) => ({ kind: 'check', ...check }));
  const edits = [...new Set(record.edits)].map((path) => ({ kind: 'edit', path }));
  return [...commands, ...checks.slice(0, -1), ...edits, ...checks.slice(-1)];
}

const clipped = (text, max) => withoutSecrets(String(text ?? '')).slice(0, max);

function redactedStep(step) {
  if (step.kind === 'edit') return { kind: 'edit', path: withoutSecrets(step.path) };
  if (step.kind === 'command') return { kind: 'command', command: clipped(step.command, COMMAND_MAX_CHARS) };
  const { command, exit, failed, output } = step;
  return {
    kind: 'check',
    command: clipped(command, COMMAND_MAX_CHARS),
    exit: Number.isInteger(exit) ? exit : null,
    failed: typeof failed === 'boolean' ? failed : null,
    ...(output && { output: withoutSecrets(output) }),
  };
}

/** The ordered steps of a turn record: its own order where the host kept one, else derived. */
export const stepsOf = (record) => (Array.isArray(record.steps) ? record.steps : derivedStepsOf(record));

/** One work turn as the session's range keeps it, redacted; `head` is `{ root, head }` when the turn began. */
export function workTurnOf({ turn, prompt, record, answer, head = null, now }) {
  return {
    turn,
    prompt: clipped(prompt, PROMPT_MAX_CHARS),
    steps: stepsOf(record).slice(-MAX_STEPS).map(redactedStep),
    answer: clipped(answer, ANSWER_MAX_CHARS),
    ...(head && { head }),
    at: now,
  };
}

export const correctionTextOf = (text) => clipped(text, CORRECTION_MAX_CHARS);

/** A work turn kept earlier, redacted again under the current rules. */
export const redactedAgain = (turn) => ({
  ...turn,
  prompt: clipped(turn.prompt, PROMPT_MAX_CHARS),
  steps: (turn.steps ?? []).map(redactedStep),
  answer: clipped(turn.answer, ANSWER_MAX_CHARS),
  ...(turn.correction && { correction: correctionTextOf(turn.correction) }),
});
