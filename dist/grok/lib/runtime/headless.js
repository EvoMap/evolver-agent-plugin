// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// A headless model run loads the agent's plugins too; this marker in its environment turns this plugin's hooks
// off there, so a distillation never recalls into its own prompt or starts more workers.
export const HEADLESS_MARKER = 'EVOLVER_HEADLESS';

export const isHeadlessRun = (env = process.env) => env[HEADLESS_MARKER] === '1';

export const headlessEnv = (env = process.env) => ({ ...env, [HEADLESS_MARKER]: '1' });
