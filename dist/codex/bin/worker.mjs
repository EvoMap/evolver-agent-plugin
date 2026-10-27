#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { runWorker } from '../lib/channels/worker/runner.js';

const [agent, ...tasks] = process.argv.slice(2);
process.exit((await runWorker(agent, tasks)) ? 0 : 1);
