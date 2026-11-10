// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { AGENT_REPORTED, OBSERVED, agentReportedReportOf, checkSourceOf, immediateReportOf } from '../reuse.js';

export { AGENT_REPORTED, OBSERVED };

// The model follows a strategy injected into its turn, so an injection is a use; whether it helped is what the
// outcome, the check, the next prompt and the edits' retention tell.
const APPLIED = 'used';

export const taskSessionId = (identity, sessionId) => `${identity.agent}:${sessionId}`;

/**
 * The turn-end reports of `assets`, each with the turn's checks. Only checks the host observed count as evidence; a
 * check the agent reported, or one of any other source, counts as exposure.
 */
export function turnReportsOf(identity, assets, { reason, checks, source = OBSERVED }) {
  const reportOf = checkSourceOf(source) === OBSERVED ? immediateReportOf : agentReportedReportOf;
  return assets.map((asset) => ({
    report: reportOf({ asset, sessionId: taskSessionId(identity, asset.sessionId), turn: asset.turn, turnReason: reason, checks, applied: APPLIED }),
    sessionId: asset.sessionId,
  }));
}
