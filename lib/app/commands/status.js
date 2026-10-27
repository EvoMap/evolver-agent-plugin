// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withoutDraft } from '../../distill.js';
import { engineNoticeOf } from '../../engine/notice.js';
import { SIGN_IN, signInOf } from '../../hub-login.js';
import { MIN_EVOLVER_VERSION } from '../../engine/version.js';
import { proxyStatusText } from '../../proxy-status.js';
import { success } from './result.js';

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

// The Proxy reports its Hub link the same whether or not the person signed in, so only a sign-in this plugin ran says.
function signInLine(state) {
  return SIGN_IN_LINES[state.state]?.(state) ?? 'Hub sign-in: /evolver-login signs you in to the EvoMap Hub, or confirms that you are.';
}

export default {
  name: 'evolver-status',
  description: 'Evolver health: the Proxy, engine setup, Hub sign-in, distillation candidate and drafts.',
  async run({ identity, proxy, engine, candidates, drafts, signIn, clock }, { sessionId, anySession }) {
    const answered = await proxy.request('GET', '/proxy/status', undefined, { timeoutMs: 3_000 });
    const waiting = withoutDraft(await drafts.read(), null, clock.now()).length;
    return success([
      answered.ok ? proxyStatusText(answered.data) : answered.error,
      engineLine(await engine.outcome(), identity.label),
      candidateLine(await candidates.read(), { sessionId, anySession }),
      `${waiting} distilled draft(s) waiting; /evolver-drafts lists them.`,
      signInLine(signInOf(await signIn.latest(), clock.now())),
    ].join('\n'));
  },
};
