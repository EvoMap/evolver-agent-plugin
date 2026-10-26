// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { engineNoticeOf } from '../engine/notice.js';
import { retentionReportsOf } from '../session/follow-ups.js';
import { markedReported, orphansOf, sessionOf } from '../session/state.js';
import { TASKS } from './ports.js';
import { turnReportsOf } from './turn-reports.js';

async function queueRetentionReports({ retention, reports }, sessionId, projectDir) {
  const { due, commit } = await retention.takeDue({ sessionId, projectDir });
  await reports.enqueue(due.flatMap(retentionReportsOf));
  await commit();
}

// Queued first and marked after, like a turn's own reports: a hook killed in between reports an orphan twice
// (the outbox keys the second away), never not at all.
async function queueOrphanReports({ identity, sessions, reports, owner, clock }) {
  const orphans = [];
  await sessions.updateEach((stored, sessionId) => {
    orphans.push(...orphansOf(sessionOf(stored), sessionId, owner.isGone));
  });
  if (orphans.length === 0) return;
  await reports.enqueue(turnReportsOf(identity, orphans, { reason: 'aborted', checks: [] }));
  await sessions.updateEach((stored, sessionId) => {
    const marked = markedReported(sessionOf(stored), orphans.filter((asset) => asset.sessionId === sessionId), clock.now());
    return marked && { ...marked, open: false };
  });
}

/**
 * Settles what earlier sessions left (retention of their edits, injections of a killed session as aborted),
 * starts engine setup, delivery and leftover distillation in the background, and answers the one-off engine
 * notice: the only text besides a recalled strategy that reaches the model.
 */
export async function sessionStarted(ports, { sessionId, projectDir }) {
  await ports.sessions.update(sessionId, (stored) => ({ ...sessionOf(stored), startedUnder: String(ports.owner.current()) }));
  await queueRetentionReports(ports, sessionId, projectDir);
  await queueOrphanReports(ports);
  const setup = (await ports.engine.needsSetup()) ? [TASKS.ENGINE] : [];
  ports.scheduler.schedule([...setup, TASKS.DRAIN, TASKS.DISTILL]);
  const outcome = await ports.engine.takeUnannounced();
  return outcome ? engineNoticeOf(outcome, ports.identity.label) : null;
}

/** Whether the session now runs under another owner process: for a host without a session-start event, a new session. */
export async function isNewOwner({ sessions, owner }, sessionId) {
  return sessionOf(await sessions.read(sessionId)).startedUnder !== String(owner.current());
}
