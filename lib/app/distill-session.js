// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { irReplyOf } from '../distill/ir.js';
import { claimedDue, claimedOwn, hasDueRange, nextDueAt, rangeOf, rangeSessionOf, settledRange, TRIGGERS, withoutExpiredLeftovers } from '../distill/range.js';
import { isSettled, needsAgentModel } from '../distill/result.js';
import { DISTILL_TIMEOUT_MS, distillClaimed, distillationOf, postedReply } from './distill-run.js';
import { TASKS } from './ports.js';

export { DISTILL_TIMEOUT_MS };
// A range due already was missed by the pass that just ran (it came due meanwhile) or by one that failed before
// settling: a wake-up a minute later takes it without respawning a failing worker in a loop. One still to come keeps
// its own time.
export const MIN_WAKE_DELAY_MS = 60_000;

async function claim({ candidates, owner, clock }, claimOf) {
  let claimed = null;
  await candidates.update((pending) => {
    const result = claimOf(pending, { pid: owner.self(), isGone: owner.isGone, now: clock.now() });
    claimed = result.claimed;
    return result.next;
  });
  return claimed;
}

const settle = ({ candidates, clock }, claimed, decision) =>
  candidates.update((pending) => settledRange(pending, claimed.sessionId, claimed.range, { ...decision, now: clock.now() }));

// Below the threshold, a session that ended is done with; one still open waits for more work. A distillation the
// person asked for leaves the range as it was.
function settlementOf(outcome, { trigger, explicit, countModelFailures }) {
  if (outcome.status === 'stopped') return {};
  if (outcome.status === 'below_threshold') return explicit ? {} : trigger === TRIGGERS.SESSION_END ? { consume: true } : { hold: true };
  if (isSettled(outcome)) return { consume: true };
  return { counted: countModelFailures || !needsAgentModel(outcome) };
}

// A run its process stopped for shutdown only gives its claim back: the next start tries the range again.
async function run(ports, claimed, { focus = '', explicit = false, countModelFailures = true } = {}) {
  const outcome = await distillClaimed(ports, claimed, { focus, explicit });
  await settle(ports, claimed, settlementOf(outcome, { trigger: claimed.trigger, explicit, countModelFailures }));
  return outcome;
}

// A command run outside any session (a terminal) acts on the newest range, or the one a Gene was written for.
async function sessionToDistill({ candidates }, { sessionId, anySession, writtenFor }) {
  const pending = await candidates.read();
  if (rangeOf(pending, sessionId) || !anySession) return sessionId;
  return rangeSessionOf(pending, { writtenFor }) ?? sessionId;
}

/**
 * Distills the session's range now (with `anySession`, the newest one when the session has none), below the amount
 * of work the background waits for but never without a passing check. A try the model failed costs no attempt here,
 * and the answer carries `agentGene` (the prompt, and `writtenFor`, the range it was written for) so a host whose own
 * agent can write the IR may hand it over.
 */
export async function distillSession(ports, { sessionId: asked, focus = '', anySession = false }) {
  const sessionId = await sessionToDistill(ports, { sessionId: asked, anySession });
  if (!rangeOf(await ports.candidates.read(), sessionId)) return { status: 'nothing' };
  const claimed = await claim(ports, (pending, owner) => claimedOwn(pending, sessionId, owner));
  if (!claimed) return { status: 'busy' };
  const outcome = await run(ports, { ...claimed, trigger: TRIGGERS.SESSION_END }, { focus, explicit: true, countModelFailures: false });
  await armDistillWakeUp(ports);
  const range = rangeOf(await ports.candidates.read(), sessionId);
  if (!needsAgentModel(outcome) || !range) return outcome;
  return { ...outcome, agentGene: { writtenFor: range.changedAt, prompt: distillationOf(range, { explicit: true, focus }).prompt } };
}

/** Distills the ranges that are due: their session is over (ended, or killed with its owner), quiet, or fixed an error. */
export async function distillDue(ports) {
  const outcomes = [];
  for (const claimed of (await claim(ports, claimedDue)) ?? []) outcomes.push(await run(ports, claimed));
  return outcomes;
}

/** Whether distillation runs in the background here: a model outside the conversation, and the person did not turn it off. */
export const distillsInBackground = ({ model, settings }) => Boolean(model) && settings?.autoDistill !== false;

/**
 * Arms background distillation for when the next range comes due (quiet long enough, or its retry delay over):
 * a session left open sends no event that would start it then.
 */
export async function armDistillWakeUp(ports) {
  if (!distillsInBackground(ports)) return;
  const now = ports.clock.now();
  const at = nextDueAt(await ports.candidates.read(), { now, isGone: ports.owner.isGone });
  if (at !== null) ports.scheduler.wakeAt(at > now ? at : now + MIN_WAKE_DELAY_MS, [TASKS.DISTILL]);
}

/**
 * Starts background distillation when a range is due for it, else arms it for the next one to come due, so a
 * session that never ends still gets its draft; a distillation started here arms the next wake-up once it ran.
 */
export async function scheduleDueDistillation(ports, alongside = []) {
  const isDue = distillsInBackground(ports) && hasDueRange(await ports.candidates.read(), { now: ports.clock.now(), isGone: ports.owner.isGone });
  const tasks = [...alongside, ...(isDue ? [TASKS.DISTILL] : [])];
  if (tasks.length > 0) ports.scheduler.schedule(tasks);
  if (!isDue) await armDistillWakeUp(ports);
}

/** Drops the leftovers that waited too long for a Gene: without a model here, nothing else would take them. */
export async function dropExpiredLeftovers({ candidates, owner, clock }) {
  await candidates.update((pending) => withoutExpiredLeftovers(pending, { now: clock.now(), isGone: owner.isGone }));
}

/**
 * Posts the IRs the agent's own model wrote for the range it was asked about (`writtenFor`), or settles the range
 * when the agent judged it not worth one. IRs written for a range that changed since are not sent: their references
 * may no longer point at the lines they meant.
 */
export async function postAgentGene(ports, { sessionId: asked, text, writtenFor, anySession = false }) {
  const sessionId = await sessionToDistill(ports, { sessionId: asked, anySession, writtenFor });
  if (!irReplyOf(text)) return { status: 'unparsed' };
  const claimed = await claim(ports, (pending, owner) => claimedOwn(pending, sessionId, owner));
  if (!claimed) return rangeOf(await ports.candidates.read(), sessionId) ? { status: 'busy' } : { status: 'nothing' };
  let outcome;
  try {
    if (claimed.range.changedAt !== writtenFor) return (outcome = { status: 'dropped' });
    const distillation = distillationOf(claimed.range, { explicit: true });
    outcome = await postedReply(ports, { ...claimed, trigger: TRIGGERS.SESSION_END }, distillation, { text, signal: AbortSignal.timeout(DISTILL_TIMEOUT_MS) });
    return outcome;
  } finally {
    await settle(ports, claimed, isSettled(outcome) ? { consume: true } : {});
    await armDistillWakeUp(ports);
  }
}
