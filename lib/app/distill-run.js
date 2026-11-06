// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withDraft } from '../distill.js';
import { corpusEntryOf, withCorpusEntry } from '../distill/corpus.js';
import { gateDetailOf, gateOf } from '../distill/gate.js';
import { irProblemOf, irReplyOf } from '../distill/ir.js';
import { irPromptOf } from '../distill/ir-prompt.js';
import { defaultKindOf } from '../distill/kinds.js';
import { withOutcome } from '../distill/outcomes.js';
import { sessionRecordOf } from '../distill/record.js';
import { distillBodiesOf } from '../distill/request.js';
import { distillResultOf, postedOutcomeOf } from '../distill/result.js';
import { taskSessionId } from './turn-reports.js';

export const DISTILL_TIMEOUT_MS = 120_000;

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

async function posted(ports, claimed, session, { irs, usage, signal }) {
  const bodies = distillBodiesOf({ platform: ports.identity.agent, sessionId: taskSessionId(ports.identity, claimed.sessionId), trigger: claimed.trigger, session, irs, usage });
  const results = [];
  for (const body of bodies) {
    const answer = await ports.proxy.request('POST', '/conversation/distill', body, { timeoutMs: DISTILL_TIMEOUT_MS, signal });
    const result = distillResultOf(answer, { title: body.ir.title, sessionId: claimed.sessionId }, ports.clock.now());
    if (result.draft) await ports.drafts.update((drafts) => withDraft(drafts, result.draft));
    results.push(await logged(ports, claimed, result));
  }
  return results;
}

/**
 * Posts the IRs a model wrote for `distillation` (a reply that is a skip, or no IR, declines it); an IR whose shape
 * could never be accepted is refused here. Every outcome is logged.
 */
export async function postedReply(ports, claimed, distillation, { text, usage = null, signal }) {
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

async function asked(ports, claimed, prompt, signal) {
  try {
    return { reply: await ports.model.complete(claimed.range.model, prompt, signal) };
  } catch (error) {
    if (ports.scheduler?.signal?.aborted) return { outcome: { status: 'stopped' } };
    const failure = await logged(ports, claimed, { status: 'failed', reason: 'model_failed', error: String(error?.message ?? error) });
    return { outcome: { ...failure, status: 'model_failed' } };
  }
}

/**
 * Distills a claimed range (`{ sessionId, range, trigger }`): below the gate there is no model call, only a logged
 * `below_threshold` (once per amount of work: a range held below it logs nothing again); otherwise the range is kept
 * for calibration, the model writes 0 to 2 IRs and each goes to the Proxy. `no_model` when no model here can.
 */
export async function distillClaimed(ports, claimed, { focus = '', explicit = false } = {}) {
  const distillation = distillationOf(claimed.range, { explicit, focus });
  const { gate } = distillation;
  if (!gate.passed && claimed.range.held) return { status: 'below_threshold', reason: gate.reason, detail: gateDetailOf(gate) };
  await keptForCalibration(ports, claimed, distillation);
  if (!gate.passed) return logged(ports, claimed, { status: 'below_threshold', reason: gate.reason, detail: gateDetailOf(gate) });
  if (!ports.model || !claimed.range.model) return { status: 'no_model' };
  const stopping = ports.scheduler?.signal;
  const signal = AbortSignal.any([AbortSignal.timeout(DISTILL_TIMEOUT_MS), ...(stopping ? [stopping] : [])]);
  const { reply, outcome } = await asked(ports, claimed, distillation.prompt, signal);
  return outcome ?? postedReply(ports, claimed, distillation, { text: reply.answer, usage: reply.usage, signal });
}
