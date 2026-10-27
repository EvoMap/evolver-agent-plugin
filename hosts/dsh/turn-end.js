// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// A `blocked` turn's step was rejected before it ran, and `interrupted` and `forked` close a turn only after the
// fact (a resume, a fork's seed): none of them says anything against the strategy, so they count as aborted.
const REASONS = Object.freeze({
  completed: 'answer',
  aborted: 'aborted',
  blocked: 'aborted',
  interrupted: 'aborted',
  forked: 'aborted',
  'max-tokens': 'error',
  error: 'error',
});

export const turnEndReason = ({ reason }) => REASONS[reason?.kind] ?? 'error';
