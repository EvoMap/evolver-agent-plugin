// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

export const OUTBOX_TTL_MS = 8 * 24 * 60 * 60 * 1000;

const keyOf = ({ report, path }) => `${path ? `${path}\0` : ''}${report.task_id}\0${report.asset_id}`;

function pruned(outbox, now) {
  return Object.fromEntries(Object.entries(outbox ?? {}).filter(([, entry]) => now - Number(entry?.queuedAt) <= OUTBOX_TTL_MS));
}

export function withQueued(outbox, queued, now) {
  const kept = pruned(outbox, now);
  for (const { report, sessionId, path } of queued) {
    kept[keyOf({ report, path })] ??= { report, sessionId, ...(path && { path }), queuedAt: now, attempts: 0 };
  }
  return kept;
}

export const SENT = 'sent';
export const REJECTED = 'rejected';
export const RETRY = 'retry';
export const RECORDED = 'recorded';
export const NOT_RECORDED = 'not_recorded';
export const UNCERTAIN = 'uncertain';

export function isSettled(entry) {
  return Boolean(entry.sentAt || entry.rejectedAt);
}

function settlementOf({ verdict, reason, status }, now) {
  if (verdict === SENT) return { sentAt: now };
  if (verdict === REJECTED) return { rejectedAt: now, rejection: { reason, ...(status !== undefined && { status }) } };
  return {};
}

function localRecordOf({ local }, entry, now) {
  if (local === RECORDED) return { localAt: now };
  if (local === NOT_RECORDED) return { localFailures: (entry.localFailures ?? 0) + 1 };
  if (local === UNCERTAIN) return { localUncertainAt: now };
  return {};
}

export function withAttempt(outbox, key, attempt, now) {
  const entry = outbox[key];
  if (!entry) return outbox;
  const attempted = { ...entry, ...(attempt.report && { report: attempt.report }), attempts: entry.attempts + 1, ...localRecordOf(attempt, entry, now) };
  return { ...outbox, [key]: { ...attempted, ...settlementOf(attempt, now) } };
}
