// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// OpenCode goes idle after every turn, finished, interrupted or failed, so how it ended is read off what came
// before: the `session.error` the turn raised and its latest assistant message's `error` and `finish`. A turn with
// no assistant message was stopped before the model answered; one cut at its length limit, or whose last step
// still wanted its tool calls answered (a denied permission), never answered.

const ABORTED = 'MessageAbortedError';
const UNANSWERED = new Set(['length', 'tool-calls', 'unknown']);

/** `{ error, lastAssistant }` of the turn → 'answer' | 'aborted' | 'error'. */
export function turnEndReason({ error, lastAssistant }) {
  const failure = error ?? lastAssistant?.error;
  if (failure) return failure.name === ABORTED ? 'aborted' : 'error';
  if (!lastAssistant) return 'aborted';
  if (!lastAssistant.finish || UNANSWERED.has(lastAssistant.finish)) return 'error';
  return 'answer';
}

/** The provider and model behind the turn's latest assistant message: distillation runs on it. */
export function modelOf(lastAssistant) {
  return lastAssistant?.providerID && lastAssistant?.modelID ? { providerID: lastAssistant.providerID, modelID: lastAssistant.modelID } : null;
}
