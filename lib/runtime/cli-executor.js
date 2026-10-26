// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { MIN_EVOLVER_VERSION } from '../engine/version.js';
import { isMissingCommand, runProcess } from './process/spawn.js';

const CLI_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_MAX_CHARS = 4_000;
// The fallback runs whatever npm resolves, so it is held to the range this plugin is built against.
const CLI_PACKAGE = `@evomap/evolver@^${MIN_EVOLVER_VERSION}`;

const shown = (text) => (text.length > OUTPUT_MAX_CHARS ? `${text.slice(0, OUTPUT_MAX_CHARS)}\n…` : text);
const outputOf = (result) => `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trim();

/** The EvolverCli port: the installed `evolver` when there is one, else the published package through npx. */
export function evolverCliOf({ cwd } = {}) {
  const run = (command, args) => runProcess(command, args, { cwd, timeoutMs: CLI_TIMEOUT_MS, shim: true });
  return {
    run: async (args) => {
      let result = await run('evolver', args);
      if (await isMissingCommand(result, 'evolver')) result = await run('npx', ['-y', CLI_PACKAGE, ...args]);
      const ok = result.code === 0 && !result.error;
      return { ok, text: shown(outputOf(result) || (ok ? 'done' : String(result.error?.message ?? `exit ${result.code}`))) };
    },
  };
}
