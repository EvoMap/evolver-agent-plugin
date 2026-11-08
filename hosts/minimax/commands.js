// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { commandCatalog, hostCommandCatalog, parsePromptCommand } from '../../lib/agent/commands.js';

const commands = [...commandCatalog, ...hostCommandCatalog];

export const isBackgroundCommand = (name, args) => commandCatalog.some((command) =>
  command.name === name && !command.forAgent && name !== 'evolver-status' && (name !== 'evolver-drafts' || Boolean(args?.trim())));

/** Slow commands are admitted to a durable worker rather than killed by the native ten-second hook budget. */
export function promptCommandOf(payload, event, { prompt }) {
  const typed = parsePromptCommand(prompt, { catalog: commands });
  return typed && isBackgroundCommand(typed.name, typed.args) ? { ...typed, background: true } : typed;
}
