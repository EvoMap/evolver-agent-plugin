// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { failure, success } from './result.js';

export const jobs = {
  name: 'evolver-jobs',
  description: 'List, inspect or cancel background Evolver commands.',
  hint: '[job <id>|cancel <id>]',
  async run({ commandJobs }, { args }) {
    if (!commandJobs) return failure('This host does not run background commands.');
    if (!args.trim()) return commandJobs.status();
    const match = /^(job|cancel)\s+(\S+)$/.exec(args.trim());
    if (!match) return failure('Usage: evolver-jobs [job <id>|cancel <id>].');
    return match[1] === 'cancel' ? commandJobs.cancel(match[2]) : commandJobs.status(match[2]);
  },
};

export const config = {
  name: 'evolver-config',
  description: 'Set persistent Evolver preferences for this host.',
  hint: '<recall|auto-distill> <on|off>',
  async run({ settings }, { args }) {
    if (!settings?.configure) return failure('This host configures Evolver through its existing settings.');
    const match = /^(recall|auto-distill)\s+(on|off)$/.exec(args.trim());
    if (!match) return failure('Usage: evolver-config <recall|auto-distill> <on|off>.');
    await settings.configure({ [match[1] === 'recall' ? 'recall' : 'autoDistill']: match[2] === 'on' });
    return success(`Recall: ${settings.recall ? 'on' : 'off'}; automatic distillation: ${settings.autoDistill ? 'on' : 'off'}.`);
  },
};
