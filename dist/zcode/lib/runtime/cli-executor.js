// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { VERIFIED_EVOLVER_VERSION } from '../engine/version.js';
import { managedEngineAt } from './engine/install.js';
import { nodeExecutable } from './process/node.js';
import { isMissingCommand, runProcess } from './process/spawn.js';

const CLI_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_MAX_CHARS = 4_000;
// npx runs whatever npm resolves, so the fallback is held to one release this plugin was verified against: a later
// one may print, or ask, differently.
const CLI_PACKAGE = `@evomap/evolver@${VERIFIED_EVOLVER_VERSION}`;

const shown = (text) => (text.length > OUTPUT_MAX_CHARS ? `${text.slice(0, OUTPUT_MAX_CHARS)}\n…` : text);
const outputOf = (result) => `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trim();

/**
 * How to run the `evolver` CLI, in the order to try: the engine this plugin installed under `enginePrefix` when
 * there is one, else the installed `evolver`, else the published package through npx when that is missing. Each is
 * `{ command, args, shim }`, the CLI's own arguments going after `args`.
 */
export function evolverCommandsOf(enginePrefix, managedEngine = managedEngineAt) {
  const managed = enginePrefix ? managedEngine(enginePrefix) : null;
  if (managed) return [{ command: nodeExecutable(), args: [managed.path], shim: false }];
  return [{ command: 'evolver', args: [], shim: true }, { command: 'npx', args: ['-y', CLI_PACKAGE], shim: true }];
}

/**
 * The EvolverCli port, run as `evolverCommandsOf` says. It runs in `cwd`, the session's project, else where this
 * process runs, since the engine acts on the repository the person works in.
 */
export function evolverCliOf({ enginePrefix, managedEngine = managedEngineAt } = {}) {
  return {
    run: async (args, { cwd, signal } = {}) => {
      const run = ({ command, args: base, shim }) => runProcess(command, [...base, ...args], { cwd: cwd || process.cwd(), timeoutMs: CLI_TIMEOUT_MS, signal, shim });
      const [first, fallback] = evolverCommandsOf(enginePrefix, managedEngine);
      let result = await run(first);
      if (fallback && (await isMissingCommand(result, first.command))) result = await run(fallback);
      const ok = result.code === 0 && !result.error;
      return { ok, text: shown(outputOf(result) || (ok ? 'done' : String(result.error?.message ?? `exit ${result.code}`))) };
    },
  };
}
