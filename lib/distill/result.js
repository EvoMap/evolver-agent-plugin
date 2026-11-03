// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { draftOf, skipReasonOf } from '../distill.js';

const SETTLED = new Set(['stored', 'drafted', 'skipped', 'declined']);
const MODEL_FAILURES = new Set(['no_model', 'model_failed', 'unparsed']);
const BLOCKED_REASONS = new Set(['route_unresolved', 'route_changed', 'credential_missing', 'auth_unsupported', 'unsafe_runtime']);

/** Only the runtime's pre-request error contract can block a candidate without consuming an attempt. */
export const blockedModelReason = error => error?.code === 'MODEL_UNAVAILABLE' && BLOCKED_REASONS.has(error.reason) ? error.reason : null;

/**
 * Interpret the Proxy's response to a private draft request. A stored response is a separate
 * outcome and cannot be reviewed as a local draft. A quality-gate rejection is also settled.
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
