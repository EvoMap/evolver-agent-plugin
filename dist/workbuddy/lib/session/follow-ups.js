// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { feedbackLabelOf } from '../feedback-label.js';
import { promptTextOf } from '../recall.js';
import { retentionOf } from '../retention.js';
import { correctionReportOf, retentionReportOf } from '../reuse.js';

/** How the person's next prompt reads the last turn: 'correction', 'praise' or null. */
export const followUpLabelOf = (prompt) => feedbackLabelOf(promptTextOf(prompt));

export function correctionReportsOf(labelable, label, sessionId) {
  return labelable
    .map((reuse) => correctionReportOf(reuse, label))
    .filter((report) => report !== null)
    .map((report) => ({ report, sessionId }));
}

/** Retention reports for an earlier turn's edits, given each file's hash before, after and now. */
export function retentionReportsOf({ sessionId, reuses, files }) {
  const verdict = retentionOf(files).class;
  return reuses
    .map((reuse) => retentionReportOf(reuse, verdict))
    .filter((report) => report !== null)
    .map((report) => ({ report, sessionId }));
}
