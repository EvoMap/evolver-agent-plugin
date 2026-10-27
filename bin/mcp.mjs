#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { readFileSync } from 'node:fs';

import { runMcpProcess } from '../lib/channels/mcp/server.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
await runMcpProcess(process.argv[2] ?? 'mcp-generic', { version }).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
