#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { runWorker } from '../lib/channels/worker/runner.js';

const [agent, ...args] = process.argv.slice(2);
process.exitCode = (await runWorker(agent, args)) ? 0 : 1;
