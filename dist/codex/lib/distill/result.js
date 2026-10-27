// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { draftOf, skipReasonOf } from '../distill.js';

const SETTLED = new Set(['stored', 'drafted', 'skipped', 'declined']);
const MODEL_FAILURES = new Set(['no_model', 'model_failed', 'unparsed']);

/**
 * What the Proxy did with a Gene. Without a host verifier (only an isolated Linux Proxy has one) it stores
 * nothing and answers the Gene and Capsule as a draft, which the person later publishes or discards. A Gene its
 * quality gate refused is settled too: sending it again gives the same answer.
 */
export function distillOutcomeOf(result, { title, sessionId }, now) {
  if (!result?.ok) return { status: 'failed', error: String(result?.error) };
  if (result.data?.status === 'stored') return { status: 'stored', data: result.data };
  const draft = draftOf(result.data, { title: title || 'Distilled Gene', sessionId }, now);
  return draft ? { status: 'drafted', draft } : { status: 'skipped', reason: skipReasonOf(result.data) };
}

/** Whether a candidate is finished with: kept, refused for good, or judged not worth a Gene. */
export const isSettled = (outcome) => SETTLED.has(outcome?.status);

/** Whether the model, not the Proxy, kept the candidate from being distilled: the agent's own model can still. */
export const needsAgentModel = (outcome) => MODEL_FAILURES.has(outcome?.status);
