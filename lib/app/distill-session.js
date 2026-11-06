// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { sameDraftSource, withConfirmedDraft, withDraft, withoutCorrectedDraft } from '../distill.js';
import { candidateSessionOf, claimedDue, claimedOwn, hasDueCandidate, isCurrentCandidate, nextDueAt, settledCandidate, withoutExpiredLeftovers } from '../distill/candidate.js';
import { argumentsOf, declineOf, distillBody, distillPrompt } from '../distill/prompt.js';
import { blockedModelReason, distillOutcomeOf, isSettled, needsAgentModel } from '../distill/result.js';
import { TASKS } from './ports.js';
import { taskSessionId } from './turn-reports.js';

export const DISTILL_TIMEOUT_MS = 120_000;
const WATCH_MS = 1_000;
// A candidate due already was missed by the pass that just ran (it came due meanwhile) or by one that failed before
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

function settle({ candidates, clock }, { sessionId, candidate }, outcome, countsFailure) {
  if (outcome?.status === 'dropped' || outcome?.status === 'cleanup_failed') return;
  return candidates.update((pending) => settledCandidate(pending, sessionId, candidate, { done: isSettled(outcome), counted: countsFailure, blocked: outcome?.status === 'blocked' ? outcome.reason : null, now: clock.now() }));
}

export function draftWasCorrected({ draftCorrections }, draft) {
  const source = draft.sourceCandidate;
  return source ? draftCorrections.has(draft.sessionId, source.turn, source.sessionEpoch) : false;
}

async function confirmDraftOutcomes(ports, outcomes) {
  if (!outcomes.some((outcome) => outcome.status === 'drafted')) return outcomes;
  const list = await ports.drafts.read();
  return Promise.all(outcomes.map(async (outcome) => {
    if (outcome.status !== 'drafted') return outcome;
    const saved = Array.isArray(list) && list.some((draft) => !draft.pendingCandidateCheck && sameDraftSource(draft, outcome.draft));
    if (saved && !await draftWasCorrected(ports, outcome.draft)) return outcome;
    return { status: 'draft_missing', ...(outcome.usage && { usage: outcome.usage }) };
  }));
}

async function saveDraft({ drafts, candidates }, { sessionId, candidate }, draft) {
  const written = await drafts.update((list) => withDraft(list, { ...draft, pendingCandidateCheck: true }));
  if (isCurrentCandidate(await candidates.read(), sessionId, candidate)) {
    if (!written) return { status: 'superseded' };
    const confirmed = await drafts.update((list) => withConfirmedDraft(list, draft));
    return confirmed ? null : { status: 'draft_missing' };
  }
  if (!written) return { status: 'dropped' };
  try {
    await drafts.update((list) => withoutCorrectedDraft(list, draft));
    return { status: 'dropped' };
  } catch {
    return { status: 'cleanup_failed' };
  }
}

async function post(ports, { sessionId, candidate, trigger }, args, usage, signal) {
  const body = distillBody({ platform: ports.identity.agent, sessionId: taskSessionId(ports.identity, sessionId), candidate, args, usage, trigger });
  const result = await ports.proxy.request('POST', '/conversation/distill', body, { timeoutMs: DISTILL_TIMEOUT_MS, signal });
  const outcome = distillOutcomeOf(result, { title: args.title, sessionId }, ports.clock.now());
  if (outcome.draft) {
    if (!isCurrentCandidate(await ports.candidates.read(), sessionId, candidate)) return { status: 'dropped' };
    const draft = { ...outcome.draft, sourceCandidate: { at: candidate.at, turn: candidate.turn, sessionEpoch: candidate.sessionEpoch } };
    const correction = await saveDraft(ports, { sessionId, candidate }, draft);
    if (correction) return correction;
    return { ...outcome, draft, ...(usage && { usage }) };
  }
  return { ...outcome, ...(usage && { usage }) };
}

// A correction in another process can drop the candidate while the model answers; the watch stops the run then.
function watchCandidate({ candidates }, { sessionId, candidate }) {
  const controller = new AbortController();
  const timer = setInterval(async () => {
    try {
      if (!isCurrentCandidate(await candidates.read(), sessionId, candidate)) controller.abort();
    } catch {
      // Retry a failed read; the fresh check before posting must still succeed.
    }
  }, WATCH_MS);
  timer.unref?.();
  return { signal: controller.signal, stop: () => clearInterval(timer) };
}

async function distillClaimed(ports, claimed, focus) {
  if (!ports.model) return { status: 'no_model' };
  if (!claimed.candidate.model) return ports.model.capture ? { status: 'blocked', reason: 'route_unresolved' } : { status: 'no_model' };
  const watch = watchCandidate(ports, claimed);
  const stopping = ports.scheduler?.signal;
  const signal = AbortSignal.any([AbortSignal.timeout(DISTILL_TIMEOUT_MS), watch.signal, ...(stopping ? [stopping] : [])]);
  try {
    const reply = await ports.model.complete(claimed.candidate.model, distillPrompt(claimed.candidate, focus), signal);
    const declined = declineOf(reply.answer);
    if (declined) return { status: 'declined', reason: declined, usage: reply.usage };
    const args = argumentsOf(reply.answer);
    if (!args) return { status: 'unparsed', usage: reply.usage };
    if (watch.signal.aborted || !isCurrentCandidate(await ports.candidates.read(), claimed.sessionId, claimed.candidate)) return { status: 'dropped' };
    return await post(ports, claimed, args, reply.usage, signal);
  } catch (error) {
    if (watch.signal.aborted) return { status: 'dropped' };
    const blocked = ports.model.capture && blockedModelReason(error);
    if (blocked) return { status: 'blocked', reason: blocked };
    return stopping?.aborted ? { status: 'stopped' } : { status: 'model_failed', error: String(error?.message ?? error) };
  } finally {
    watch.stop();
  }
}

// A run its process stopped for shutdown only gives its claim back: the next start tries the candidate again.
async function run(ports, claimed, { focus = '', countModelFailures = true } = {}) {
  const outcome = await distillClaimed(ports, claimed, focus);
  const counts = !['stopped', 'blocked'].includes(outcome.status) && (countModelFailures || !needsAgentModel(outcome));
  await settle(ports, claimed, outcome, counts);
  return outcome;
}

// A command run outside any session (a terminal) acts on the newest candidate, or the one a Gene was written for.
async function sessionToDistill({ candidates }, { sessionId, anySession, writtenFor }) {
  if (!anySession) return sessionId;
  const pending = await candidates.read();
  if (writtenFor === undefined) return pending[sessionId] ? sessionId : candidateSessionOf(pending) ?? sessionId;
  const match = Object.entries(pending).find(([id, candidate]) => candidate && candidates.referenceOf(id, candidate) === writtenFor);
  return match?.[0] ?? sessionId;
}

/**
 * Distills the session's candidate now (with `anySession`, the newest one when the session has none). A try the
 * model failed costs no attempt here, and the answer carries `agentGene` (the candidate and its prompt) so a host
 * whose own agent can write the Gene may hand it over.
 */
export async function distillSession(ports, { sessionId: asked, focus = '', anySession = false }) {
  const sessionId = await sessionToDistill(ports, { sessionId: asked, anySession });
  if (!(await ports.candidates.read())[sessionId]) return { status: 'nothing' };
  const claimed = await claim(ports, (pending, owner) => claimedOwn(pending, sessionId, owner));
  if (!claimed) return { status: 'busy' };
  const outcome = await run(ports, claimed, { focus, countModelFailures: false });
  await armDistillWakeUp(ports);
  if (!needsAgentModel(outcome)) return (await confirmDraftOutcomes(ports, [outcome]))[0];
  const due = (await ports.candidates.read())[sessionId];
  return due ? { ...outcome, agentGene: { writtenFor: ports.candidates.referenceOf(sessionId, due), prompt: distillPrompt(due, focus) } } : outcome;
}

/** Distills the candidates that are due: their session is over (ended, or killed with its owner) or quiet. */
export async function distillDue(ports) {
  const outcomes = [];
  for (const claimed of (await claim(ports, claimedDue)) ?? []) outcomes.push(await run(ports, claimed));
  return confirmDraftOutcomes(ports, outcomes);
}

/** Whether distillation runs in the background here: a model outside the conversation, and the person did not turn it off. */
export const distillsInBackground = ({ model, settings }) => Boolean(model) && settings?.autoDistill !== false;

/**
 * Arms background distillation for when the next candidate comes due (quiet long enough, or its retry delay over):
 * a session left open sends no event that would start it then.
 */
export async function armDistillWakeUp(ports) {
  if (!distillsInBackground(ports)) return;
  const now = ports.clock.now();
  const at = nextDueAt(await ports.candidates.read(), { now, isGone: ports.owner.isGone });
  if (at !== null) ports.scheduler.wakeAt(at > now ? at : now + MIN_WAKE_DELAY_MS, [TASKS.DISTILL]);
}

/**
 * Starts background distillation when a candidate is due for it, else arms it for the next one to come due, so a
 * session that never ends still gets its draft; a distillation started here arms the next wake-up once it ran.
 */
export async function scheduleDueDistillation(ports, alongside = []) {
  const isDue = distillsInBackground(ports) && hasDueCandidate(await ports.candidates.read(), { now: ports.clock.now(), isGone: ports.owner.isGone });
  const tasks = [...alongside, ...(isDue ? [TASKS.DISTILL] : [])];
  if (tasks.length > 0) ports.scheduler.schedule(tasks);
  if (!isDue) await armDistillWakeUp(ports);
}

/** Drops the leftovers that waited too long for a Gene: without a model here, nothing else would take them. */
export async function dropExpiredLeftovers({ candidates, owner, clock }) {
  await candidates.update((pending) => withoutExpiredLeftovers(pending, { now: clock.now(), isGone: owner.isGone }));
}

/**
 * Posts the Gene the agent's own model wrote for the candidate identified by `writtenFor`, or settles it when the agent
 * judged it not worth one. A Gene written for a candidate since replaced is not sent.
 */
export async function postAgentGene(ports, { sessionId: asked, text, writtenFor, anySession = false }) {
  const sessionId = await sessionToDistill(ports, { sessionId: asked, anySession, writtenFor });
  const declined = declineOf(text);
  const args = declined ? null : argumentsOf(text);
  if (!declined && !args) return { status: 'unparsed' };
  const claimed = await claim(ports, (pending, owner) => claimedOwn(pending, sessionId, owner));
  if (!claimed) return (await ports.candidates.read())[sessionId] ? { status: 'busy' } : { status: 'nothing' };
  let outcome;
  try {
    if (ports.candidates.referenceOf(sessionId, claimed.candidate) !== writtenFor) return { status: 'dropped' };
    outcome = declined ? { status: 'declined', reason: declined } : await post(ports, claimed, args, null, AbortSignal.timeout(DISTILL_TIMEOUT_MS));
  } finally {
    await settle(ports, claimed, outcome, false);
    await armDistillWakeUp(ports);
  }
  return (await confirmDraftOutcomes(ports, [outcome]))[0];
}
