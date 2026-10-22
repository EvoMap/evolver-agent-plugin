#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// The hooks module runs without Node, so evolver-core's root_events ingestor
// runs here, one JSON request on stdin and one JSON answer on stdout.

import { recordReuseLocally } from '../lib/local-ledger.js';

const COMMANDS = {
  'record-reuse': async (request) => ({ recorded: await recordReuseLocally(request) }),
};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const command = COMMANDS[process.argv[2]];
if (!command) {
  process.stdout.write(JSON.stringify({ error: `unknown command: ${process.argv[2]}` }));
  process.exit(2);
}

try {
  process.stdout.write(JSON.stringify(await command(JSON.parse(await readStdin()))));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String(error?.message ?? error) }));
  process.exit(1);
}
