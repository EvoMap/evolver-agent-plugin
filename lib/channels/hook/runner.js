// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { runBackgroundTasks } from '../../app/background.js';
import { createDriver } from '../../agent/driver.js';
import { EVENTS } from '../../agent/events.js';
import { profileNamed } from '../../agent/registry.js';
import { EPHEMERAL, environmentFor } from '../../runtime/environment.js';
import { isHeadlessRun } from '../../runtime/headless.js';
import { exitProcess } from '../../runtime/process/exit.js';
import { transcripts } from '../../runtime/transcripts.js';
import { recallOnlyReply } from './recall-only.js';
import { readPayload } from './stdin.js';

const WORKER_FAILURE = 'Evolver could not confirm that the Windows background worker started. Check whether Windows PowerShell is available and allowed. Pending work is retried in the next session.';

/**
 * One command-hook invocation: the host's payload on stdin and the agent's answer as JSON on stdout. Inside
 * this plugin's own headless distillation the hook answers the agent's empty reply and does nothing else.
 * `startedAt` is when the host's clock on the hook began: the hook process passes its own start, so Node's start and
 * the imports count against the budget.
 */
export async function runHookProcess(agent, hostEvent, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env, exit, profileOf = profileNamed, startedAt = Date.now() } = {}) {
  const profile = await profileOf(agent).catch(() => null);
  const finish = exit ?? ((code) => exitProcess(code, { drainWindowsHandles: profile?.drainWindowsHandles, stdin }));
  const write = (answer) => stdout.write(JSON.stringify(answer ?? {}), () => finish(0));
  if (!profile) return write({});
  const payload = await readPayload(stdin);
  if (isHeadlessRun(env)) return write(profile.reply.empty(hostEvent));
  if (profile.recallOnly) {
    const answer = await recallOnlyReply({ profile, hostEvent, payload, env, startedAt }).catch(() => profile.reply.empty(hostEvent, payload));
    return write(answer);
  }
  let workerLaunchFailed = false;
  const { ports } = environmentFor({ profile, env, lifetime: EPHEMERAL, runBackground: runBackgroundTasks,
    onWorkerLaunchFailure: () => { workerLaunchFailed = true; },
  });
  const driver = createDriver({ profile, ports, transcripts, env, lifetime: EPHEMERAL, startedAt });
  let diagnostic;
  const answer = await driver.handle(hostEvent, payload, {
    onError(error) {
      if (['EINVALIDSTATE', 'ESTATEIO', 'ELOCKED'].includes(error?.code)) {
        diagnostic = `Evolver hook skipped a state operation (${error.code}). Check the plugin state directory and retry.\n`;
      }
    },
  });
  // The host discards successful SessionEnd output, so use stderr and a nonzero exit to surface the failure.
  if (workerLaunchFailed && profile.events[hostEvent] === EVENTS.SESSION_END) {
    return stderr.write(`${diagnostic ?? ''}${WORKER_FAILURE}\n`, () => finish(1));
  }
  const reply = workerLaunchFailed ? { ...answer, systemMessage: [answer?.systemMessage, WORKER_FAILURE].filter(Boolean).join('\n') } : answer;
  if (diagnostic) return stderr.write(diagnostic, () => write(reply));
  return write(reply);
}
