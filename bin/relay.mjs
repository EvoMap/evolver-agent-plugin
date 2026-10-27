#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { runRelayProcess } from '../lib/channels/relay/server.js';

runRelayProcess(process.argv[2]).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
