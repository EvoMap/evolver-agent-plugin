// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { runBackgroundTasks } from '../../app/background.js';
import { createDriver } from '../../agent/driver.js';
import { profileNamed } from '../../agent/registry.js';
import { EPHEMERAL, environmentFor } from '../../runtime/environment.js';
import { isHeadlessRun } from '../../runtime/headless.js';
import { transcripts } from '../../runtime/transcripts.js';
import { readPayload } from './stdin.js';

/**
 * One command-hook invocation: the host's payload on stdin, the agent's answer as JSON on stdout, exit 0. Inside
 * this plugin's own headless distillation the hook answers the agent's empty reply and does nothing else.
 */
export async function runHookProcess(agent, hostEvent, { stdin = process.stdin, stdout = process.stdout, env = process.env, exit = process.exit, profileOf = profileNamed } = {}) {
  const startedAt = Date.now();
  const write = (answer) => stdout.write(JSON.stringify(answer ?? {}), () => exit(0));
  const profile = await profileOf(agent).catch(() => null);
  if (!profile) return write({});
  const payload = await readPayload(stdin);
  if (isHeadlessRun(env)) return write(profile.reply.empty(hostEvent));
  const { ports } = environmentFor({ profile, env, lifetime: EPHEMERAL, runBackground: runBackgroundTasks });
  const driver = createDriver({ profile, ports, transcripts, lifetime: EPHEMERAL, startedAt });
  return write(await driver.handle(hostEvent, payload));
}
