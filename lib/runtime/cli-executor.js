// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { MIN_EVOLVER_VERSION } from '../engine/version.js';
import { managedEngineAt } from './engine/install.js';
import { isMissingCommand, runProcess } from './process/spawn.js';

const CLI_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_MAX_CHARS = 4_000;
// The fallback runs whatever npm resolves, so it is held to the range this plugin is built against.
const CLI_PACKAGE = `@evomap/evolver@^${MIN_EVOLVER_VERSION}`;

const shown = (text) => (text.length > OUTPUT_MAX_CHARS ? `${text.slice(0, OUTPUT_MAX_CHARS)}\n…` : text);
const outputOf = (result) => `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trim();

/**
 * The EvolverCli port: the engine this plugin installed under `enginePrefix` when there is one, else the installed
 * `evolver`, else the published package through npx. It runs in `cwd`, the session's project, since the engine
 * acts on the repository the person works in.
 */
export function evolverCliOf({ enginePrefix, managedEngine = managedEngineAt } = {}) {
  return {
    run: async (args, { cwd } = {}) => {
      const run = (command, commandArgs, shim) => runProcess(command, commandArgs, { cwd: cwd || undefined, timeoutMs: CLI_TIMEOUT_MS, shim });
      const managed = enginePrefix ? managedEngine(enginePrefix) : null;
      let result = managed ? await run(process.execPath, [managed.path, ...args], false) : await run('evolver', args, true);
      if (!managed && (await isMissingCommand(result, 'evolver'))) result = await run('npx', ['-y', CLI_PACKAGE, ...args], true);
      const ok = result.code === 0 && !result.error;
      return { ok, text: shown(outputOf(result) || (ok ? 'done' : String(result.error?.message ?? `exit ${result.code}`))) };
    },
  };
}
