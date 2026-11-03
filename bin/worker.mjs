#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { runWorkerProcess } from '../lib/channels/worker/runner.js';

const [agent, ...tasks] = process.argv.slice(2);
await runWorkerProcess(agent, tasks);
