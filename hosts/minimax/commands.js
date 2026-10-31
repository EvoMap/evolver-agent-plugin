// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { commandCatalog } from '../../lib/agent/commands.js';

const FAST = new Set(['evolver-status', 'evolver-evolve']);

export const isBackgroundCommand = name => commandCatalog.some(command => command.name === name) && !FAST.has(name);

/** Slow commands are admitted to a durable worker rather than killed by the native ten-second hook budget. */
export function promptCommandOf(payload, event, { prompt }) {
  const match = /^\/?(evolver-[a-z]+)(?:\s+([\s\S]*))?$/.exec(String(prompt ?? '').trim());
  const command = match && commandCatalog.find(item => item.name === match[1]);
  if (!command) return null;
  const args = (match[2] ?? '').trim();
  if (!command.hint && args && !(command.name === 'evolver-status' && /^(?:(recall|auto-distill)\s+(on|off)|jobs|(?:job|cancel)\s+\S+)$/.test(args))) return null;
  const typed = { name: command.name, args };
  if (FAST.has(command.name) || (command.name === 'evolver-drafts' && !args)) return typed;
  return { ...typed, background: true };
}
