#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { runRelayProcess } from '../lib/channels/relay/server.js';

const [agent, ...flags] = process.argv.slice(2);
runRelayProcess(agent, { useModel: !flags.includes('--no-model') }).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
