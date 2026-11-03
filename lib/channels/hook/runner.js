// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { runBackgroundTasks } from '../../app/background.js';
import { createDriver } from '../../agent/driver.js';
import { profileNamed } from '../../agent/registry.js';
import { EPHEMERAL, environmentFor } from '../../runtime/environment.js';
import { isHeadlessRun } from '../../runtime/headless.js';
import { exitProcess } from '../../runtime/process/exit.js';
import { transcripts } from '../../runtime/transcripts.js';
import { readPayload } from './stdin.js';

/**
 * One command-hook invocation: the host's payload on stdin, the agent's answer as JSON on stdout, exit 0. Inside
 * this plugin's own headless distillation the hook answers the agent's empty reply and does nothing else.
 */
export async function runHookProcess(agent, hostEvent, { stdin = process.stdin, stdout = process.stdout, env = process.env, exit, profileOf = profileNamed } = {}) {
  const startedAt = Date.now();
  const profile = await profileOf(agent).catch(() => null);
  const finish = exit ?? ((code) => exitProcess(code, { drainWindowsHandles: profile?.drainWindowsHandles, stdin }));
  const write = (answer) => stdout.write(JSON.stringify(answer ?? {}), () => finish(0));
  if (!profile) return write({});
  const payload = await readPayload(stdin);
  if (isHeadlessRun(env)) return write(profile.reply.empty(hostEvent));
  const { ports } = environmentFor({ profile, env, lifetime: EPHEMERAL, runBackground: runBackgroundTasks });
  const driver = createDriver({ profile, ports, transcripts, env, lifetime: EPHEMERAL, startedAt });
  return write(await driver.handle(hostEvent, payload));
}
