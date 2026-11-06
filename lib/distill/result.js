// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { draftOf, skipReasonOf } from '../distill.js';

const SETTLED = new Set(['stored', 'drafted', 'rejected', 'declined', 'below_threshold']);
const MODEL_FAILURES = new Set(['no_model', 'model_failed', 'unparsed']);

function rejectionOf(data) {
  const quality = data?.quality;
  if (quality?.ok !== false) return { reason: skipReasonOf(data) };
  return {
    reason: String(quality.reason ?? 'quality_gate'),
    ...(Array.isArray(quality.terms) && quality.terms.length > 0 && { terms: quality.terms.map(String) }),
    ...(quality.field && { field: String(quality.field) }),
  };
}

/**
 * What the Proxy did with one IR: `stored`; `drafted` when it answers the Gene and Capsule as a draft, without a host
 * verifier to store them (the person publishes or discards it later); `rejected`, with the typed reason and the
 * offending terms, when its quality gate or intake refused it, which sending again would not change; `failed` when it
 * could not be reached.
 */
export function distillResultOf(result, { title, sessionId }, now) {
  if (!result?.ok) return { status: 'failed', title, reason: 'proxy_unreachable', error: String(result?.error) };
  if (result.data?.status === 'stored') return { status: 'stored', title, data: result.data };
  const draft = draftOf(result.data, { title, sessionId }, now);
  return draft ? { status: 'drafted', title, draft } : { status: 'rejected', by: 'proxy', title, ...rejectionOf(result.data) };
}

const PRECEDENCE = ['stored', 'drafted', 'rejected', 'failed'];

/** One distillation's outcome from its IRs' results: the best of them leads; it failed only when every post failed. */
export function postedOutcomeOf(results) {
  const status = PRECEDENCE.find((candidate) => results.some((result) => result.status === candidate)) ?? 'failed';
  return { status, results };
}

/** Whether a distillation is finished with: kept, refused for good, judged not worth a Gene, or below the threshold. */
export const isSettled = (outcome) => SETTLED.has(outcome?.status);

/** Whether the model, not the Proxy, kept the range from being distilled: the agent's own model can still. */
export const needsAgentModel = (outcome) => MODEL_FAILURES.has(outcome?.status);
