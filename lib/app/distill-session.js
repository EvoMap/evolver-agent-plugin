// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { sameDraftSource, withDraft, withoutCorrectedDraft } from '../distill.js';
import { candidateReferenceOf, candidateSessionOf, claimedLeftovers, claimedOwn, isCurrentCandidate, settledCandidate, withoutExpiredLeftovers } from '../distill/candidate.js';
import { argumentsOf, declineOf, distillBody, distillPrompt } from '../distill/prompt.js';
import { distillOutcomeOf, isSettled, needsAgentModel } from '../distill/result.js';
import { taskSessionId } from './turn-reports.js';

export const DISTILL_TIMEOUT_MS = 120_000;
const WATCH_MS = 1_000;

async function claim({ candidates, owner }, claimOf) {
  let claimed = null;
  await candidates.update((pending) => {
    const result = claimOf(pending, { pid: owner.self(), isGone: owner.isGone });
    claimed = result.claimed;
    return result.next;
  });
  return claimed;
}

function settle({ candidates }, { sessionId, candidate }, outcome, countsFailure) {
  if (outcome?.status === 'dropped' || outcome?.status === 'cleanup_failed') return;
  return candidates.update((pending) => settledCandidate(pending, sessionId, candidate, { done: isSettled(outcome), counted: countsFailure }));
}

async function confirmDraftOutcomes({ drafts }, outcomes) {
  if (!outcomes.some((outcome) => outcome.status === 'drafted')) return outcomes;
  // Correction can remove a draft during settlement or a later run in the same batch.
  const list = await drafts.read();
  return outcomes.map((outcome) => {
    if (outcome.status !== 'drafted' || (Array.isArray(list) && list.some((draft) => sameDraftSource(draft, outcome.draft)))) return outcome;
    return { status: 'draft_missing', ...(outcome.usage && { usage: outcome.usage }) };
  });
}

async function saveDraft({ drafts, candidates }, { sessionId, candidate }, draft) {
  const written = await drafts.update((list) => withDraft(list, draft));
  if (isCurrentCandidate(await candidates.read(), sessionId, candidate)) return written ? null : { status: 'superseded' };
  if (!written) return { status: 'dropped' };
  try {
    await drafts.update((list) => withoutCorrectedDraft(list, draft));
    return { status: 'dropped' };
  } catch {
    return { status: 'cleanup_failed' };
  }
}

async function post(ports, { sessionId, candidate }, args, usage, signal) {
  const body = distillBody({ platform: ports.identity.agent, sessionId: taskSessionId(ports.identity, sessionId), candidate, args, usage });
  const result = await ports.proxy.request('POST', '/conversation/distill', body, { timeoutMs: DISTILL_TIMEOUT_MS, signal });
  const outcome = distillOutcomeOf(result, { title: args.title, sessionId }, ports.clock.now());
  if (outcome.draft) {
    if (!isCurrentCandidate(await ports.candidates.read(), sessionId, candidate)) return { status: 'dropped' };
    const draft = { ...outcome.draft, sourceCandidate: { at: candidate.at, turn: candidate.turn } };
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
    if (!isCurrentCandidate(await candidates.read(), sessionId, candidate)) controller.abort();
  }, WATCH_MS);
  timer.unref?.();
  return { signal: controller.signal, stop: () => clearInterval(timer) };
}

async function distillClaimed(ports, claimed, focus) {
  if (!ports.model || !claimed.candidate.model) return { status: 'no_model' };
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
    return stopping?.aborted ? { status: 'stopped' } : { status: 'model_failed', error: String(error?.message ?? error) };
  } finally {
    watch.stop();
  }
}

// A run its process stopped for shutdown only gives its claim back: the next start tries the candidate again.
async function run(ports, claimed, { focus = '', countModelFailures = true } = {}) {
  const outcome = await distillClaimed(ports, claimed, focus);
  const counts = outcome.status !== 'stopped' && (countModelFailures || !needsAgentModel(outcome));
  await settle(ports, claimed, outcome, counts);
  return outcome;
}

// A command run outside any session (a terminal) acts on the newest candidate, or the one a Gene was written for.
async function sessionToDistill({ candidates }, { sessionId, anySession, writtenFor }) {
  if (!anySession) return sessionId;
  const pending = await candidates.read();
  if (writtenFor === undefined && pending[sessionId]) return sessionId;
  return candidateSessionOf(pending, { writtenFor }) ?? sessionId;
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
  if (!needsAgentModel(outcome)) return (await confirmDraftOutcomes(ports, [outcome]))[0];
  const due = (await ports.candidates.read())[sessionId];
  return due ? { ...outcome, agentGene: { writtenFor: candidateReferenceOf(sessionId, due), prompt: distillPrompt(due, focus) } } : outcome;
}

/** Distills the candidates of sessions that are over: ended, or killed with their owner. */
export async function distillLeftovers(ports) {
  const outcomes = [];
  for (const claimed of (await claim(ports, claimedLeftovers)) ?? []) outcomes.push(await run(ports, claimed));
  return confirmDraftOutcomes(ports, outcomes);
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
    if (candidateReferenceOf(sessionId, claimed.candidate) !== writtenFor) return { status: 'dropped' };
    outcome = declined ? { status: 'declined', reason: declined } : await post(ports, claimed, args, null, AbortSignal.timeout(DISTILL_TIMEOUT_MS));
  } finally {
    await settle(ports, claimed, outcome, false);
  }
  return (await confirmDraftOutcomes(ports, [outcome]))[0];
}
