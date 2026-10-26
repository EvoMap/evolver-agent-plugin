#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { runBackgroundTasks } from '../lib/app/background.js';
import { profileNamed } from '../lib/agent/registry.js';
import { EPHEMERAL, environmentFor } from '../lib/runtime/environment.js';

const [agent, ...tasks] = process.argv.slice(2);
const profile = await profileNamed(agent).catch(() => null);
const isClean = profile && (await environmentFor({ profile, lifetime: EPHEMERAL, runBackground: runBackgroundTasks }).runTasks(tasks));
process.exit(isClean ? 0 : 1);
