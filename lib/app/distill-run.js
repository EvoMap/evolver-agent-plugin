// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { draftSourcesOf, withConfirmedDraft, withDraft, withoutCorrectedDraft } from '../distill.js';
import { corpusEntryOf, withCorpusEntry } from '../distill/corpus.js';
import { gateDetailOf, gateOf } from '../distill/gate.js';
import { irProblemOf, irReplyOf } from '../distill/ir.js';
import { irPromptOf } from '../distill/ir-prompt.js';
import { defaultKindOf } from '../distill/kinds.js';
import { withOutcome } from '../distill/outcomes.js';
import { isCurrentRange } from '../distill/range.js';
import { sessionRecordOf } from '../distill/record.js';
import { distillBodiesOf } from '../distill/request.js';
import { blockedModelReason, distillResultOf, isDiscarded, postedOutcomeOf } from '../distill/result.js';
import { withoutSecrets } from '../redact.js';
import { taskSessionId } from './turn-reports.js';

export const DISTILL_TIMEOUT_MS = 120_000;
const WATCH_MS = 1_000;

/**
 * What one distillation of `range` reads: the gate's verdict (the person asking for it, `explicit`, waives the amount
 * of work), the record fitted to the Proxy's limit, the record's default kind and the prompt the model gets.
 */
export function distillationOf(range, { explicit = false, focus = '' } = {}) {
  const gate = gateOf(range.turns, { needsAmount: !explicit });
  const session = sessionRecordOf(range);
  const kind = defaultKindOf(session.turns);
  return { gate, session, kind, prompt: irPromptOf({ record: session.record, kind, focus }) };
}

const entryOf = ({ status, title, by, reason, detail, terms, field, error }) => ({
  status, ...(title && { title }), ...(by && { by }), ...(reason && { reason }), ...(detail && { detail }), ...(terms && { terms }), ...(field && { field }), ...(error && { error }),
});

async function logged(ports, claimed, outcome) {
  const entry = { ...entryOf(outcome), session: taskSessionId(ports.identity, claimed.sessionId), trigger: claimed.trigger, at: ports.clock.now() };
  await ports.outcomes?.update((log) => withOutcome(log, entry));
  return outcome;
}

async function keptForCalibration(ports, claimed, { gate, kind, session }) {
  const entry = corpusEntryOf({
    platform: ports.identity.agent, sessionId: taskSessionId(ports.identity, claimed.sessionId), trigger: claimed.trigger, range: claimed.range, gate, kind, session, now: ports.clock.now(),
  });
  await ports.corpus?.update((corpus) => withCorpusEntry(corpus, entry));
}

const isCurrent = async ({ candidates }, { sessionId, range, exact }) => isCurrentRange(await candidates.read(), sessionId, range, { exact });

/**
 * The turn whose later correction would invalidate a draft of `range`: its last. One corrected already when the range
 * was read cannot be corrected again, and its correction mark does not concern the draft.
 */
function draftSourceOf(range) {
  const last = range.turns.at(-1);
  return { at: range.at, turn: last.turn, sessionEpoch: last.sessionEpoch ?? range.sessionEpoch, ...(last.correction && { sawCorrection: true }) };
}

/** Whether a correction of a turn `draft` was distilled from came after it was (see `draftSourceOf`). */
export async function draftWasCorrected({ draftCorrections }, draft) {
  const sources = draftSourcesOf(draft).filter((source) => !source.corrected && !source.sawCorrection);
  const marks = await Promise.all(sources.map(({ turn, sessionEpoch }) => draftCorrections.has(draft.sessionId, turn, sessionEpoch)));
  return marks.some(Boolean);
}

const isStale = async (ports, claimed) => !(await isCurrent(ports, claimed))
  || draftWasCorrected(ports, { sessionId: claimed.sessionId, sourceCandidate: draftSourceOf(claimed.range) });

// A correction may land between any two steps: the draft is written unconfirmed, the range checked again, and only
// then confirmed; a range that changed takes its draft back, and one it cannot take back stays unpublishable.
async function savedDraft(ports, claimed, result) {
  const draft = { ...result.draft, sourceCandidate: draftSourceOf(claimed.range) };
  const missed = (status) => ({ status, title: result.title });
  const written = await ports.drafts.update((list) => withDraft(list, { ...draft, pendingCandidateCheck: true }));
  if (await isCurrent(ports, claimed)) {
    if (!written) return missed('superseded');
    const confirmed = await ports.drafts.update((list) => withConfirmedDraft(list, draft));
    return confirmed ? { ...result, draft } : missed('draft_missing');
  }
  if (!written) return missed('dropped');
  try {
    await ports.drafts.update((list) => withoutCorrectedDraft(list, draft));
    return missed('dropped');
  } catch {
    return missed('cleanup_failed');
  }
}

// What the Proxy stored stands; any other answer for work that changed while it was asked for is discarded.
async function keptResult(ports, claimed, result) {
  if (result.status === 'stored') return result;
  if (await isStale(ports, claimed)) return { status: 'dropped', title: result.title };
  return result.draft ? savedDraft(ports, claimed, result) : result;
}

async function posted(ports, claimed, session, { irs, usage, signal }) {
  const bodies = distillBodiesOf({ platform: ports.identity.agent, sessionId: taskSessionId(ports.identity, claimed.sessionId), trigger: claimed.trigger, session, irs, usage });
  const results = [];
  for (const body of bodies) {
    // The range watch polls; a correction since the last look (while a refused IR was logged, or during the previous
    // request) must stop the next request before it is sent. The correction lock is held through dispatch only.
    const started = await ports.draftCorrections.withSession(claimed.sessionId, async () => (await isStale(ports, claimed)
      ? null : { response: ports.proxy.request('POST', '/conversation/distill', body, { timeoutMs: DISTILL_TIMEOUT_MS, signal }) }), signal);
    if (!started) {
      results.push(await logged(ports, claimed, { status: 'dropped', title: body.ir.title }));
      break;
    }
    const answer = await started.response;
    const result = await keptResult(ports, claimed, distillResultOf(answer, { title: body.ir.title, sessionId: claimed.sessionId }, ports.clock.now()));
    results.push(await logged(ports, claimed, result));
    if (isDiscarded(result)) break;
  }
  return results;
}

/**
 * Posts the IRs a model wrote for `distillation` (a reply that is a skip, or no IR, declines it); an IR whose shape
 * could never be accepted is refused here. Every outcome is logged.
 */
export async function postedReply(ports, claimed, distillation, { text, usage = null, signal }) {
  if (await isStale(ports, claimed)) return { status: 'dropped' };
  const reply = irReplyOf(text);
  if (!reply) return { ...(await logged(ports, claimed, { status: 'failed', reason: 'unparsed' })), status: 'unparsed', ...(usage && { usage }) };
  if (reply.skip || reply.irs.length === 0) return { ...(await logged(ports, claimed, { status: 'declined', reason: reply.skip ?? 'no IR' })), ...(usage && { usage }) };
  const lineCount = distillation.session.record.length;
  const refused = [];
  for (const ir of reply.irs.filter((candidate) => irProblemOf(candidate, lineCount))) {
    refused.push(await logged(ports, claimed, { status: 'rejected', by: 'plugin', title: String(ir.title ?? ''), reason: 'ir_invalid', field: irProblemOf(ir, lineCount) }));
  }
  const irs = reply.irs.filter((candidate) => !irProblemOf(candidate, lineCount));
  const results = irs.length > 0 ? await posted(ports, claimed, distillation.session, { irs, usage, signal }) : [];
  return { ...postedOutcomeOf([...results, ...refused]), ...(usage && { usage }) };
}

// A correction of a turn the model is reading makes its answer stale: the model call stops rather than finish it.
function watchRange(ports, claimed) {
  const controller = new AbortController();
  const timer = setInterval(async () => {
    try {
      if (await isStale(ports, claimed)) controller.abort();
    } catch {
      // Retry a failed read; the fresh check before posting must still succeed.
    }
  }, WATCH_MS);
  timer.unref?.();
  return { signal: controller.signal, stop: () => clearInterval(timer) };
}

async function asked(ports, claimed, prompt, { signal, watched }) {
  try {
    return { reply: await ports.model.complete(claimed.range.model, prompt, signal) };
  } catch (error) {
    if (watched.aborted) return { outcome: await logged(ports, claimed, { status: 'dropped' }) };
    const blocked = ports.model.capture && blockedModelReason(error);
    if (blocked) return { outcome: await logged(ports, claimed, { status: 'blocked', reason: blocked }) };
    if (ports.scheduler?.signal?.aborted) return { outcome: { status: 'stopped' } };
    const failure = await logged(ports, claimed, { status: 'failed', reason: 'model_failed', error: withoutSecrets(String(error?.message ?? error)) });
    return { outcome: { ...failure, status: 'model_failed' } };
  }
}

// A model that captures the route each session used must not stand in the current route for a range that kept none.
async function withoutRoute(ports, claimed) {
  if (!ports.model.capture) return { status: 'no_model' };
  await logged(ports, claimed, { status: 'failed', reason: 'route_not_captured' });
  return { status: 'route_not_captured' };
}

/**
 * Distills a claimed range (`{ sessionId, range, trigger }`): below the gate there is no model call, only a logged
 * `below_threshold` (once per amount of work: a range held below it logs nothing again); otherwise the range is kept
 * for calibration, the model writes 0 to 2 IRs and each goes to the Proxy. `no_model` when no model here can;
 * `blocked` when the session's model route is unavailable; `dropped` when a turn it read was corrected meanwhile.
 */
export async function distillClaimed(ports, claimed, { focus = '', explicit = false } = {}) {
  if (await isStale(ports, claimed)) return { status: 'dropped' };
  const distillation = distillationOf(claimed.range, { explicit, focus });
  const { gate } = distillation;
  if (!gate.passed && claimed.range.held) return { status: 'below_threshold', reason: gate.reason, detail: gateDetailOf(gate) };
  await keptForCalibration(ports, claimed, distillation);
  if (!gate.passed) return logged(ports, claimed, { status: 'below_threshold', reason: gate.reason, detail: gateDetailOf(gate) });
  if (!ports.model) return { status: 'no_model' };
  if (!claimed.range.model) return withoutRoute(ports, claimed);
  const watch = watchRange(ports, claimed);
  const stopping = ports.scheduler?.signal;
  const signal = AbortSignal.any([AbortSignal.timeout(DISTILL_TIMEOUT_MS), watch.signal, ...(stopping ? [stopping] : [])]);
  try {
    const { reply, outcome } = await asked(ports, claimed, distillation.prompt, { signal, watched: watch.signal });
    if (outcome) return outcome;
    if (watch.signal.aborted || !(await isCurrent(ports, claimed))) return logged(ports, claimed, { status: 'dropped' });
    return await postedReply(ports, claimed, distillation, { text: reply.answer, usage: reply.usage, signal });
  } finally {
    watch.stop();
  }
}
