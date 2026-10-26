// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runProcess } from './process/spawn.js';
import { executableOf } from './process/which.js';

const ERROR_MAX_CHARS = 300;

/**
 * The ModelRunner an agent's model declaration asks for:
 *   { kind: 'cli', command: (env) → path | null, or { names, dirs?(env) } to look for, args(model, prompt) → string[],
 *     parse({ stdout, stderr }) → { answer, usage }, input?(prompt) → stdin text ('' when the prompt is an argument),
 *     workdir?: 'empty' (a fresh folder, removed after), shim? }
 *   { kind: 'sdk', complete? }   an in-process host API; without `complete` here, the host's entry passes the model
 *                                 port itself when it builds the channel
 *   { kind: 'in-session' } | null                                no model outside the conversation
 * A cli run gets the prompt on stdin and the headless marker, and is killed with its tree on timeout or cancel.
 */
export function modelRunnerOf(declaration, env = process.env) {
  if (declaration?.kind === 'sdk') return typeof declaration.complete === 'function' ? { complete: declaration.complete } : null;
  if (declaration?.kind !== 'cli') return null;
  const command = typeof declaration.command === 'function'
    ? declaration.command(env)
    : executableOf({ names: declaration.command.names, dirs: declaration.command.dirs?.(env) ?? [] }, { env });
  if (!command) return null;
  return {
    complete: async (model, prompt, signal) => {
      const workdir = declaration.workdir === 'empty' ? mkdtempSync(join(tmpdir(), 'evolver-model-')) : undefined;
      try {
        const input = declaration.input ? declaration.input(prompt) : prompt;
        const result = await runProcess(command, declaration.args(model, prompt), { input, cwd: workdir, env, signal, shim: declaration.shim, headless: true });
        if (result.error) throw result.error;
        if (result.code !== 0) throw new Error(`${command} exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-ERROR_MAX_CHARS)}`);
        return declaration.parse(result);
      } finally {
        if (workdir) rmSync(workdir, { recursive: true, force: true });
      }
    },
  };
}
