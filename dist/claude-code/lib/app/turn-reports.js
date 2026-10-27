// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { agentReportedReportOf, immediateReportOf } from '../reuse.js';

// The model follows a strategy injected into its turn, so an injection is a use; whether it helped is what the
// outcome, the check, the next prompt and the edits' retention tell.
const APPLIED = 'used';

export const OBSERVED = 'observed';
export const AGENT_REPORTED = 'agent_reported';

export const taskSessionId = (identity, sessionId) => `${identity.agent}:${sessionId}`;

/** The turn-end reports of `assets`, each with the turn's checks; a check the agent only reported counts as exposure. */
export function turnReportsOf(identity, assets, { reason, checks, source = OBSERVED }) {
  const reportOf = source === AGENT_REPORTED ? agentReportedReportOf : immediateReportOf;
  return assets.map((asset) => ({
    report: reportOf({ asset, sessionId: taskSessionId(identity, asset.sessionId), turn: asset.turn, turnReason: reason, checks, applied: APPLIED }),
    sessionId: asset.sessionId,
  }));
}
