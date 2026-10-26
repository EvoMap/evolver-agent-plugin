// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { runProcess } from './process/spawn.js';

const ERROR_MAX_CHARS = 300;

/**
 * The ModelRunner an agent's model declaration asks for:
 *   { kind: 'cli', command(env) → path | null, args(model) → string[], parse({ stdout, stderr }) → { answer, usage }, shim? }
 *   { kind: 'sdk', complete? }   an in-process host API; without `complete` here, the host's entry passes the model
 *                                 port itself when it builds the channel
 *   { kind: 'in-session' } | null                                no model outside the conversation
 * A cli run gets the prompt on stdin and the headless marker, and is killed with its tree on timeout or cancel.
 */
export function modelRunnerOf(declaration, env = process.env) {
  if (declaration?.kind === 'sdk') return typeof declaration.complete === 'function' ? { complete: declaration.complete } : null;
  if (declaration?.kind !== 'cli') return null;
  const command = declaration.command(env);
  if (!command) return null;
  return {
    complete: async (model, prompt, signal) => {
      const result = await runProcess(command, declaration.args(model), { input: prompt, env, signal, shim: declaration.shim, headless: true });
      if (result.error) throw result.error;
      if (result.code !== 0) throw new Error(`${command} exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-ERROR_MAX_CHARS)}`);
      return declaration.parse(result);
    },
  };
}
