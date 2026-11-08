// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// UserPromptSubmit sees the prompt as typed, before Qoder expands a command file, so the hook answers the plugin's
// commands itself. Qoder registers them as `/evolver-plugin:evolver-status` and resolves `/evolver-status` too. A
// leading slash always makes a command in Qoder: text after one that takes no argument is dropped, since letting the
// prompt through would have the model read the command file's hooks-are-off fallback.

import { parsePromptCommand } from '../../lib/agent/commands.js';

export function promptCommandOf(prompt) {
  return parsePromptCommand(prompt, { namespace: 'evolver-plugin', requireSlash: true, ignoreExtra: true });
}
