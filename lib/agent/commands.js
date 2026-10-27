// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { COMMANDS } from '../app/commands/index.js';

/** What a host may show of the plugin's commands: name, description, input hint, and whether it is a prompt for the agent. */
export const commandCatalog = Object.freeze(COMMANDS.map(({ name, description, hint, forAgent }) => Object.freeze({ name, description, hint, forAgent: Boolean(forAgent) })));
