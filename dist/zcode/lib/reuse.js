// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { UNKNOWN } from './applied.js';
import { checkEvidenceOf } from './checks.js';
import { NOT_RECORDED, RECORDED, REJECTED, RETRY, SENT, UNCERTAIN, isSettled, withAttempt } from './report-outbox.js';
import { outcomeOfReason } from './turn-outcomes.js';

export const OBSERVED = 'observed';
export const AGENT_REPORTED = 'reported';

/** Who saw a turn's checks run: only the host's own observation counts as one, any other value is the agent's report. */
export const checkSourceOf = (source) => (source === OBSERVED ? OBSERVED : AGENT_REPORTED);

const LABEL_OUTCOMES = { correction: 'failed', praise: 'success' };
const RETENTION_OUTCOMES = { kept: 'success', reverted: 'failed' };

export function turnTaskId(sessionId, turn) {
  return `${sessionId || 'unknown'}:${turn ?? 'unknown'}`;
}

const UNKNOWN_APPLIED_AS = 'partial';

export function immediateEvidenceOf({ checks, applied, turnReason, source = OBSERVED }) {
  const check = checkEvidenceOf(checks);
  const isKnown = applied !== UNKNOWN;
  return {
    tier: check && isKnown ? 'L1' : 'none',
    applied: isKnown ? applied : UNKNOWN_APPLIED_AS,
    ...(check && { check }),
    source: checkSourceOf(source),
    aborted: turnReason === 'aborted',
    stage: 'immediate',
  };
}

function immediateOutcomeOf(evidence, turnReason) {
  if (evidence.check) return evidence.check.passed ? 'success' : 'failed';
  return outcomeOfReason(turnReason) ?? 'failed';
}

function checkPhrase(check, lastCheck) {
  if (!check) return lastCheck ? 'last check result unknown' : 'no check ran';
  const result = check.passed ? 'passed' : 'failed';
  return `last ${check.kind} ${result}${check.fail_then_pass ? ' after failing earlier' : ''}`;
}

function reportOf({ assetId, taskId, outcome, reason, evidence }) {
  return { asset_id: assetId, outcome, task_id: taskId, reason, evidence };
}

export function immediateReportOf({ asset, sessionId, turn, turnReason, checks, applied, source }) {
  const evidence = immediateEvidenceOf({ checks, applied, turnReason, source });
  return reportOf({
    assetId: asset.assetId,
    taskId: turnTaskId(sessionId, turn),
    outcome: immediateOutcomeOf(evidence, turnReason),
    reason: `Injected by Evolver into turn ${turn}; applied: ${applied}; ${checkPhrase(evidence.check, checks?.at(-1))}.`,
    evidence,
  });
}

// A check the agent reports about itself is a claim, not an observation, so its report counts as exposure only.
export function agentReportedReportOf({ asset, sessionId, turn, turnReason, checks }) {
  const report = immediateReportOf({ asset, sessionId, turn, turnReason, checks, applied: 'used', source: AGENT_REPORTED });
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

const MAX_LOCAL_FAILURES = 3;
const REJECTED_BY_HUB = /^hub (?:400|422)\b/;

// A trial control whose withholding is unknown or expired, or was answered already, would get the same answer again.
const NOT_WITHHELD = 'not_withheld';
const TAKEN_REASONS = new Set(['duplicate_report', 'duplicate']);

function isRejection(data) {
  return data?.terminal === true || REJECTED_BY_HUB.test(String(data?.reason ?? '')) || data?.reason === NOT_WITHHELD;
}

function isTaken(data) {
  return data?.recorded !== false || TAKEN_REASONS.has(data?.reason);
}

export function deliveryOf(result) {
  if (result?.ok !== true) return { verdict: RETRY };
  if (isRejection(result.data)) return { verdict: REJECTED, reason: String(result.data.reason ?? 'rejected'), status: result.data.status };
  return { verdict: isTaken(result.data) ? SENT : RETRY };
}

const REUSE_RESULT_PATH = '/asset/reuse-result';

async function postToHub(proxyFetch, { report, path = REUSE_RESULT_PATH }) {
  try {
    return deliveryOf(await proxyFetch('POST', path, report));
  } catch {
    return { verdict: RETRY };
  }
}

function isLocalRecordOwed({ report, path, localAt, localUncertainAt, localFailures = 0, rejectedAt }) {
  return !path && !localAt && !localUncertainAt && !rejectedAt && localFailures < MAX_LOCAL_FAILURES && report.evidence.tier !== 'none';
}

/** Whether a report the Hub took still waits for its local ledger record. */
export const isLocalRecordDue = (entry) => Boolean(entry.sentAt) && isLocalRecordOwed(entry);

async function recordedLocally(recordLocally, { report, sessionId }) {
  try {
    const recorded = await recordLocally({ assetId: report.asset_id, outcome: report.outcome, sessionId });
    return { local: recorded ? RECORDED : NOT_RECORDED };
  } catch {
    return { local: UNCERTAIN };
  }
}

async function postedOf(ledgers, entry) {
  const delivery = await postToHub(ledgers.proxyFetch, entry);
  if (delivery.verdict === REJECTED) await ledgers.onRejected({ taskId: entry.report.task_id, assetId: entry.report.asset_id, ...delivery });
  return delivery;
}

async function attemptOf(ledgers, entry) {
  const delivery = await postedOf(ledgers, entry);
  if (delivery.verdict === REJECTED || !isLocalRecordOwed(entry)) return delivery;
  return { ...delivery, ...await recordedLocally(ledgers.recordLocally, entry) };
}

/** Posts the unsettled reports to the Hub and records none locally: `deliverPending` records them afterwards. */
export async function postPending(ledgers, outbox, now, afterAttempt = () => {}) {
  let posted = outbox;
  for (const [key, entry] of Object.entries(outbox).filter(([, candidate]) => !isSettled(candidate))) {
    posted = withAttempt(posted, key, await postedOf(ledgers, entry), now);
    afterAttempt();
  }
  return posted;
}

// Hub deliveries go first, so retrying an earlier report's local record never holds a new report back.
export async function deliverPending(ledgers, outbox, now, afterAttempt = () => {}) {
  const entries = Object.entries(outbox);
  const attempts = [
    ...entries.filter(([, entry]) => !isSettled(entry)).map(([key, entry]) => [key, () => attemptOf(ledgers, entry)]),
    ...entries.filter(([, entry]) => isLocalRecordDue(entry))
      .map(([key, entry]) => [key, () => recordedLocally(ledgers.recordLocally, entry)]),
  ];
  let delivered = outbox;
  for (const [key, attempt] of attempts) {
    delivered = withAttempt(delivered, key, await attempt(), now);
    afterAttempt();
  }
  return delivered;
}
