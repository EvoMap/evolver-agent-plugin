// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { argumentsOf } from './arguments.js';

function cliCommand(subcommand, description, hint) {
  return {
    name: `evolver-${subcommand}`,
    description,
    hint,
    run: ({ cli }, { args }) => cli.run([subcommand, ...argumentsOf(args)]),
  };
}

export default [
  cliCommand('sync', 'Sync assets between the local store and the EvoMap Hub (evolver sync).', '[--scope=…] [--type=…] [--dry-run]'),
  cliCommand('review', "Review Evolver's pending evolved changes, then approve or reject them (evolver review).", '[--approve | --reject]'),
  cliCommand('run', 'Run one Evolver self-evolution cycle on this repository (evolver run).', '[--loop] [--dry-run] [--strategy=…]'),
  cliCommand('solidify', 'Solidify the working changes into a durable Gene or Capsule (evolver solidify).', '[--dry-run] [--intent=…] [--summary=…]'),
];
