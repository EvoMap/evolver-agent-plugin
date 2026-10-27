#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { runHookProcess } from '../lib/channels/hook/runner.js';

const [agent, hostEvent] = process.argv.slice(2);
await runHookProcess(agent, hostEvent);
