// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// A Codex plugin cannot add slash commands, so a command is typed into the prompt box as it is (a leading `/` is
// accepted) and the prompt hook answers it. Only a prompt that is exactly a command counts, so a prompt that merely
// starts with a command's name stays a prompt, and one with text after a command that takes none (it has no hint).

import { commandCatalog } from '../../lib/agent/commands.js';

export const COMMAND_NAMES = Object.freeze(commandCatalog.map((command) => command.name));
export const TAKES_NO_ARGUMENTS = Object.freeze(commandCatalog.filter((command) => !command.hint).map((command) => command.name));

const TYPED = /^\/?(evolver-[a-z]+)(?:\s+([\s\S]*))?$/;

/** The command a prompt is, `{ name, args }` with its raw argument text, or null for any other prompt. */
export function promptCommandOf(prompt) {
  const match = TYPED.exec(String(prompt ?? '').trim());
  if (!match || !COMMAND_NAMES.includes(match[1])) return null;
  const args = (match[2] ?? '').trim();
  return TAKES_NO_ARGUMENTS.includes(match[1]) && args ? null : { name: match[1], args };
}
