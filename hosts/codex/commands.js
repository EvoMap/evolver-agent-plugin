// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// A Codex plugin cannot add slash commands, so a command is typed into the prompt box as it is (a leading `/` is
// accepted) and the prompt hook answers it. Only a prompt that is exactly a command counts, so a prompt that merely
// starts with a command's name stays a prompt: the names are listed here, and `evolver-status` takes no argument.

export const COMMAND_NAMES = Object.freeze([
  'evolver-status', 'evolver-search', 'evolver-distill', 'evolver-drafts', 'evolver-evolve',
  'evolver-sync', 'evolver-review', 'evolver-run', 'evolver-solidify',
]);
export const TAKES_NO_ARGUMENTS = Object.freeze(['evolver-status']);

const TYPED = /^\/?(evolver-[a-z]+)(?:\s+([\s\S]*))?$/;

/** The command a prompt is, `{ name, args }` with its raw argument text, or null for any other prompt. */
export function promptCommandOf(prompt) {
  const match = TYPED.exec(String(prompt ?? '').trim());
  if (!match || !COMMAND_NAMES.includes(match[1])) return null;
  const args = (match[2] ?? '').trim();
  return TAKES_NO_ARGUMENTS.includes(match[1]) && args ? null : { name: match[1], args };
}
