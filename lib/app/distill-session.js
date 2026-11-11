// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { sameDraftSource } from '../distill.js';
import { irReplyOf } from '../distill/ir.js';
import { claimedDue, claimedOwn, hasDueRange, nextDueAt, rangeOf, rangeSessionOf, settledRange, TRIGGERS, withoutExpiredLeftovers } from '../distill/range.js';
import { isDiscarded, isSettled, needsAgentModel, postedOutcomeOf } from '../distill/result.js';
import { DISTILL_TIMEOUT_MS, blockedRangeOf, distillClaimed, distillationOf, draftWasCorrected, postedReply, usesCapturedRoute } from './distill-run.js';
import { TASKS } from './ports.js';

export { DISTILL_TIMEOUT_MS, draftWasCorrected };
// A range due already was missed by the pass that just ran (it came due meanwhile) or by one that failed before
// settling: a wake-up a minute later takes it without respawning a failing worker in a loop. One still to come keeps
// its own time.
export const MIN_WAKE_DELAY_MS = 60_000;

async function claim({ candidates, owner, native, clock }, claimOf) {
  let claimed = null;
  await candidates.update((pending) => {
    const options = { pid: owner.self(), isGone: owner.isGone, requireCompletedChecks: Boolean(native), now: clock.now() };
    const pruned = withoutExpiredLeftovers(pending, { ...options, blockedOnly: true });
    const result = claimOf(pruned ?? pending, options);
    claimed = result.claimed;
    return result.next ?? pruned;
  });
  return claimed;
}

const settle = ({ candidates, clock }, claimed, decision) =>
  candidates.update((pending) => settledRange(pending, claimed.sessionId, claimed.range, { ...decision, now: clock.now() }));

// Below the threshold, a session that ended is done with; one still open waits for more work. A distillation the
// person asked for leaves the range as it was, as does one whose answer was discarded: the range, with the
// correction that discarded it, waits for the next.
function settlementOf(outcome, { trigger, explicit, countModelFailures }) {
  if (!outcome || outcome.status === 'stopped' || isDiscarded(outcome)) return {};
  if (outcome.status === 'blocked') return { blocked: outcome.reason };
  if (outcome.status === 'below_threshold') return explicit ? {} : trigger === TRIGGERS.SESSION_END ? { consume: true } : { hold: true };
  if (isSettled(outcome)) return { consume: true };
  return { counted: countModelFailures || !needsAgentModel(outcome), blocked: null };
}

// A run its process stopped for shutdown only gives its claim back: the next start tries the range again.
async function run(ports, claimed, { focus = '', explicit = false, countModelFailures = true } = {}) {
  let outcome;
  try {
    outcome = await distillClaimed(ports, claimed, { focus, explicit });
  } finally {
    await settle(ports, claimed, settlementOf(outcome, { trigger: claimed.trigger, explicit, countModelFailures }));
  }
  return outcome;
}

// A draft reported as made must still be saved as made, and not corrected since, when the person reads the answer.
async function confirmedDraft(ports, list, result) {
  const saved = Array.isArray(list) && list.some((draft) => !draft.pendingCandidateCheck && sameDraftSource(draft, result.draft));
  return saved && !(await draftWasCorrected(ports, result.draft)) ? result : { status: 'draft_missing', title: result.title };
}

async function confirmDraftOutcomes(ports, outcomes) {
  const isDrafted = (result) => result.status === 'drafted';
  if (!outcomes.some((outcome) => outcome.results?.some(isDrafted))) return outcomes;
  const list = await ports.drafts.read();
  return Promise.all(outcomes.map(async (outcome) => {
    if (!outcome.results?.some(isDrafted)) return outcome;
    const results = await Promise.all(outcome.results.map((result) => (isDrafted(result) ? confirmedDraft(ports, list, result) : result)));
    return { ...outcome, ...postedOutcomeOf(results) };
  }));
}

// A command run outside any session (a terminal) acts on the newest range, or the one a Gene was written for.
async function sessionToDistill({ candidates }, { sessionId, anySession, writtenFor }) {
  if (!anySession) return sessionId;
  const pending = await candidates.read();
  if (writtenFor === undefined) return rangeOf(pending, sessionId) ? sessionId : rangeSessionOf(pending) ?? sessionId;
  return rangeSessionOf(pending, (id, range) => candidates.referenceOf(id, range) === writtenFor) ?? sessionId;
}

/**
 * Distills the session's range now (with `anySession`, the newest one when the session has none), below the amount
 * of work the background waits for but never without a passing check. A try the model failed costs no attempt here,
 * and the answer carries `agentGene` (the prompt, and `writtenFor`, the reference of the range it was written for) so
 * a host whose own agent can write the IR may hand it over.
 */
export async function distillSession(ports, { sessionId: asked, focus = '', anySession = false }) {
  const sessionId = await sessionToDistill(ports, { sessionId: asked, anySession });
  if (!rangeOf(await ports.candidates.read(), sessionId)) return { status: 'nothing' };
  const claimed = await claim(ports, (pending, owner) => claimedOwn(pending, sessionId, owner));
  if (!claimed) return rangeOf(await ports.candidates.read(), sessionId) ? { status: 'busy' } : { status: 'nothing' };
  const outcome = await run(ports, { ...claimed, trigger: TRIGGERS.SESSION_END }, { focus, explicit: true, countModelFailures: false });
  await armDistillWakeUp(ports);
  if (!needsAgentModel(outcome)) return (await confirmDraftOutcomes(ports, [outcome]))[0];
  const range = rangeOf(await ports.candidates.read(), sessionId);
  if (!range || usesCapturedRoute(ports, range)) return outcome;
  const { gate, prompt } = distillationOf(range, { explicit: true, focus });
  return gate.passed ? { ...outcome, agentGene: { writtenFor: ports.candidates.referenceOf(sessionId, range), prompt } } : outcome;
}

/** Distills the ranges that are due: their session is over (ended, or killed with its owner), quiet, or fixed an error. */
export async function distillDue(ports) {
  const outcomes = [];
  const claims = (await claim(ports, claimedDue)) ?? [];
  try {
    for (const claimed of claims) outcomes.push(await run(ports, claimed));
  } catch (error) {
    // A failed run must also return the batch's claims that never reached run's settlement.
    await ports.candidates.update((pending) => {
      let next;
      for (const claimed of claims) {
        next = settledRange(next ?? pending, claimed.sessionId, claimed.range, { now: ports.clock.now() }) ?? next;
      }
      return next;
    });
    throw error;
  }
  return confirmDraftOutcomes(ports, outcomes);
}

/** Whether distillation runs in the background here: a model outside the conversation, and the person did not turn it off. */
export const distillsInBackground = ({ model, settings }) => Boolean(model) && settings?.autoDistill !== false;

/**
 * Arms the worker for when the next range comes due (quiet long enough, or its retry delay over), or, also where
 * nothing distills in the background, for when a blocked route expires: a session left open sends no event then.
 */
export async function armDistillWakeUp(ports) {
  const now = ports.clock.now();
  const at = nextDueAt(await ports.candidates.read(), {
    now, isGone: ports.owner.isGone, requireCompletedChecks: Boolean(ports.native), includeDistillation: distillsInBackground(ports),
  });
  if (at !== null) ports.scheduler.wakeAt(at > now ? at : now + MIN_WAKE_DELAY_MS, [TASKS.DISTILL]);
}

/**
 * Starts background distillation when a range is due for it, else arms it for the next one to come due, so a
 * session that never ends still gets its draft; a distillation started here arms the next wake-up once it ran.
 */
export async function scheduleDueDistillation(ports, alongside = []) {
  const isDue = distillsInBackground(ports) && hasDueRange(await ports.candidates.read(), {
    now: ports.clock.now(), isGone: ports.owner.isGone, requireCompletedChecks: Boolean(ports.native),
  });
  const tasks = [...alongside, ...(isDue ? [TASKS.DISTILL] : [])];
  if (tasks.length > 0) ports.scheduler.schedule(tasks);
  if (!isDue) await armDistillWakeUp(ports);
}

/** Drops the leftovers that waited too long for a Gene: without a model here, nothing else would take them. */
export async function dropExpiredLeftovers({ candidates, owner, clock }) {
  await candidates.update((pending) => withoutExpiredLeftovers(pending, { now: clock.now(), isGone: owner.isGone }));
}

/**
 * Posts the IRs the agent's own model wrote for the range it was asked about (`writtenFor`, its reference), or
 * settles the range when the agent judged it not worth one. IRs written for a range that changed since are not sent:
 * their references may no longer point at the lines they meant.
 */
export async function postAgentGene(ports, { sessionId: asked, text, writtenFor, anySession = false }) {
  const sessionId = await sessionToDistill(ports, { sessionId: asked, anySession, writtenFor });
  if (!irReplyOf(text)) return { status: 'unparsed' };
  const claimed = await claim(ports, (pending, owner) => claimedOwn(pending, sessionId, owner));
  if (!claimed) return rangeOf(await ports.candidates.read(), sessionId) ? { status: 'busy' } : { status: 'nothing' };
  let outcome;
  try {
    if (ports.candidates.referenceOf(sessionId, claimed.range) !== writtenFor) return (outcome = { status: 'dropped' });
    const blocked = blockedRangeOf(ports, claimed.range);
    if (blocked) return (outcome = blocked);
    if (usesCapturedRoute(ports, claimed.range)) return (outcome = { status: 'dropped' });
    const distillation = distillationOf(claimed.range, { explicit: true });
    if (!distillation.gate.passed) return (outcome = { status: 'dropped' });
    outcome = await postedReply(ports, { ...claimed, trigger: TRIGGERS.SESSION_END, exact: true }, distillation, { text, signal: AbortSignal.timeout(DISTILL_TIMEOUT_MS) });
  } finally {
    const decision = outcome?.status === 'blocked' ? { blocked: outcome.reason } : isSettled(outcome) ? { consume: true } : {};
    await settle(ports, claimed, decision);
    await armDistillWakeUp(ports);
  }
  return (await confirmDraftOutcomes(ports, [outcome]))[0];
}
