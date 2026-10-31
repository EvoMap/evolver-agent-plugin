// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withoutDraft } from '../../distill.js';
import { engineNoticeOf } from '../../engine/notice.js';
import { SIGN_IN, signInOf } from '../../hub-login.js';
import { MIN_EVOLVER_VERSION } from '../../engine/version.js';
import { proxyStatusText } from '../../proxy-status.js';
import { failure, success } from './result.js';

function candidateLine(pending, { sessionId, anySession }) {
  if (anySession) {
    const waiting = Object.keys(pending).length;
    return waiting === 0 ? 'No distillation candidate is waiting.' : `${waiting} verified turn(s) waiting to be distilled; /evolver-distill takes the newest.`;
  }
  return pending[sessionId] ? 'This session has a verified turn waiting to be distilled.' : 'No distillation candidate in this session.';
}

function engineLine(outcome, label) {
  if (!outcome) return `Required Evolver: ${MIN_EVOLVER_VERSION} or newer; no engine setup has run yet.`;
  const notice = engineNoticeOf(outcome, label);
  return `Required Evolver: ${MIN_EVOLVER_VERSION} or newer. Engine setup: ${outcome.status}${outcome.version ? ` (${outcome.version})` : ''}.${notice ? `\n${notice}` : ''}`;
}

const SIGN_IN_LINES = {
  [SIGN_IN.STARTING]: () => 'A sign-in to the EvoMap Hub is starting; /evolver-login shows its link and code.',
  [SIGN_IN.WAITING]: ({ url, code }) => `A sign-in to the EvoMap Hub waits for your approval: open ${url} and enter the code ${code}.`,
  [SIGN_IN.SIGNED_IN]: ({ hub }) => `Signed in to ${hub}; /evolver-login shows the registered node.`,
  [SIGN_IN.FAILED]: ({ reason }) => `The last sign-in to the EvoMap Hub failed (${reason}); /evolver-login starts a new one.`,
};

function signInLine(state) {
  return SIGN_IN_LINES[state.state]?.(state) ?? 'Hub sign-in: /evolver-login signs you in to the EvoMap Hub; within about an hour of an approval it answers at once, after that it asks for a new one.';
}

export default {
  name: 'evolver-status',
  description: 'Evolver health: the Proxy, engine setup, Hub sign-in, distillation candidate and drafts.',
  async run({ identity, proxy, engine, candidates, drafts, signIn, clock, settings, commandJobs }, { sessionId, anySession, args = '' }) {
    const preferences = () => `Recall: ${settings.recall ? 'on' : 'off'}; automatic distillation: ${settings.autoDistill ? 'on' : 'off'}.`;
    if (args.trim()) {
      const job = /^(jobs|job|cancel)(?:\s+(\S+))?$/.exec(args.trim());
      if (job && commandJobs) {
        if ((job[1] === 'jobs' && job[2]) || (job[1] !== 'jobs' && !job[2])) return failure('Usage: evolver-status jobs | job <id> | cancel <id>.');
        return job[1] === 'cancel' ? commandJobs.cancel(job[2]) : commandJobs.status(job[2]);
      }
      const match = /^(recall|auto-distill)\s+(on|off)$/.exec(args.trim());
      if (!match) return failure('Usage: evolver-status [recall|auto-distill on|off].');
      if (!settings?.configure) return failure('This host configures recall and automatic distillation through its existing settings.');
      await settings.configure({ [match[1] === 'recall' ? 'recall' : 'autoDistill']: match[2] === 'on' });
      return success(preferences());
    }
    const answered = await proxy.request('GET', '/proxy/status', undefined, { timeoutMs: 3_000 });
    const waiting = withoutDraft(await drafts.read(), null, clock.now()).length;
    return success([
      answered.ok ? proxyStatusText(answered.data) : answered.error,
      engineLine(await engine.outcome(), identity.label),
      candidateLine(await candidates.read(), { sessionId, anySession }),
      `${waiting} distilled draft(s) waiting; /evolver-drafts lists them.`,
      ...(settings?.file ? [preferences(), `Plugin settings: ${settings.file}`, ...(settings.error ? [settings.error] : [])] : []),
      signInLine(signInOf(await signIn.latest(), clock.now())),
    ].join('\n'));
  },
};
