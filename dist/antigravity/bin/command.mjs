#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { runCommandScript } from '../lib/channels/script/runner.js';

const [agent, name, ...argv] = process.argv.slice(2);
await runCommandScript(agent, name, { argv });
