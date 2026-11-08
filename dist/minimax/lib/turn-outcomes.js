// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

const TURN_OUTCOMES = {
  answer: 'success',
  aborted: 'failed',
  refusal: 'failed',
  error: 'failed',
};

export function outcomeOfReason(turnReason) {
  return TURN_OUTCOMES[turnReason] ?? null;
}
