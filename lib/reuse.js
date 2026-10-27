// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { UNKNOWN } from './applied.js';
import { checkEvidenceOf } from './checks.js';
import { REJECTED, RETRY, SENT, isSettled, withAttempt } from './report-outbox.js';
import { outcomeOfReason } from './turn-outcomes.js';

const LABEL_OUTCOMES = { correction: 'failed', praise: 'success' };
const RETENTION_OUTCOMES = { kept: 'success', reverted: 'failed' };

export function turnTaskId(sessionId, turn) {
  return `${sessionId || 'unknown'}:${turn ?? 'unknown'}`;
}

const UNKNOWN_APPLIED_AS = 'partial';

export function immediateEvidenceOf({ checks, applied, turnReason }) {
  const check = checkEvidenceOf(checks);
  const isKnown = applied !== UNKNOWN;
  return {
    tier: check && isKnown ? 'L1' : 'none',
    applied: isKnown ? applied : UNKNOWN_APPLIED_AS,
    ...(check && { check }),
    aborted: turnReason === 'aborted',
    stage: 'immediate',
  };
}

function immediateOutcomeOf(evidence, turnReason) {
  if (evidence.check) return evidence.check.passed ? 'success' : 'failed';
  return outcomeOfReason(turnReason) ?? 'failed';
}

function checkPhrase(check) {
  if (!check) return 'no check ran';
  const result = check.passed ? 'passed' : 'failed';
  return `last ${check.kind} ${result}${check.fail_then_pass ? ' after failing earlier' : ''}`;
}

function reportOf({ assetId, taskId, outcome, reason, evidence }) {
  return { asset_id: assetId, outcome, task_id: taskId, reason, evidence };
}

export function immediateReportOf({ asset, sessionId, turn, turnReason, checks, applied }) {
  const evidence = immediateEvidenceOf({ checks, applied, turnReason });
  return reportOf({
    assetId: asset.assetId,
    taskId: turnTaskId(sessionId, turn),
    outcome: immediateOutcomeOf(evidence, turnReason),
    reason: `Injected by Evolver into turn ${turn}; applied: ${applied}; ${checkPhrase(evidence.check)}.`,
    evidence,
  });
}

// A check the agent reports about itself is a claim, not an observation, so its report counts as exposure only.
export function agentReportedReportOf({ asset, sessionId, turn, turnReason, checks }) {
  const report = immediateReportOf({ asset, sessionId, turn, turnReason, checks, applied: 'used' });
  return {
    ...report,
    reason: report.reason.replace(/\.$/, '; as the agent reported it.'),
    evidence: { ...report.evidence, tier: 'none', reported_by: 'agent' },
  };
}

export function reportedReuseOf(report) {
  return { assetId: report.asset_id, applied: report.evidence.applied, taskId: report.task_id };
}

export function correctionReportOf(reuse, label) {
  if (!LABEL_OUTCOMES[label]) return null;
  return reportOf({
    ...reuse,
    taskId: `${reuse.taskId}:correction`,
    outcome: LABEL_OUTCOMES[label],
    reason: `The person's next prompt read as ${label} of the turn that reused this strategy.`,
    evidence: { tier: 'L3', applied: reuse.applied, stage: 'correction' },
  });
}

export function retentionReportOf(reuse, retentionClass) {
  if (!RETENTION_OUTCOMES[retentionClass]) return null;
  return reportOf({
    ...reuse,
    taskId: `${reuse.taskId}:retention`,
    outcome: RETENTION_OUTCOMES[retentionClass],
    reason: `By the next session the files the turn edited were ${retentionClass}.`,
    evidence: { tier: 'L2', applied: reuse.applied, stage: 'retention' },
  });
}

const REJECTED_BY_HUB = /^hub (?:400|422)\b/;

function isRejection(data) {
  return data?.terminal === true || REJECTED_BY_HUB.test(String(data?.reason ?? ''));
}

function isTaken(data) {
  return data?.recorded !== false || data?.reason === 'duplicate_report';
}

export function deliveryOf(result) {
  if (result?.ok !== true) return { verdict: RETRY };
  if (isRejection(result.data)) return { verdict: REJECTED, reason: String(result.data.reason ?? 'rejected'), status: result.data.status };
  return { verdict: isTaken(result.data) ? SENT : RETRY };
}

async function postToHub(proxyFetch, report) {
  try {
    return deliveryOf(await proxyFetch('POST', '/asset/reuse-result', report));
  } catch {
    return { verdict: RETRY };
  }
}

function isLocalRecordDue({ report, localAt }, delivery) {
  return !localAt && delivery.verdict !== REJECTED && report.evidence.tier !== 'none';
}

async function recordedLocally(recordLocally, { report, sessionId }) {
  return recordLocally({ assetId: report.asset_id, outcome: report.outcome, sessionId }).catch(() => false);
}

async function attemptOf(ledgers, entry) {
  const delivery = await postToHub(ledgers.proxyFetch, entry.report);
  const isLocal = isLocalRecordDue(entry, delivery) && (await recordedLocally(ledgers.recordLocally, entry));
  if (delivery.verdict === REJECTED) await ledgers.onRejected({ taskId: entry.report.task_id, assetId: entry.report.asset_id, ...delivery });
  return { ...delivery, isLocal };
}

export async function deliverPending(ledgers, outbox, now, afterAttempt = () => {}) {
  let delivered = outbox;
  for (const [key, entry] of Object.entries(outbox)) {
    if (isSettled(entry)) continue;
    delivered = withAttempt(delivered, key, await attemptOf(ledgers, entry), now);
    afterAttempt();
  }
  return delivered;
}
