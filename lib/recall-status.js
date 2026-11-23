// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// The one line a host pins under its prompt while a turn runs: what the recall for that turn decided, including the
// recalls that injected nothing, so a quiet turn is told apart from one that never recalled.

const NAME_MAX_CHARS = 48;
const PREFIX = 'evolver ·';

const quoted = (name) => `"${String(name ?? 'EvoMap strategy').slice(0, NAME_MAX_CHARS)}"`;

export const RECALLING_STATUS = `${PREFIX} recalling an EvoMap strategy for this prompt…`;

function skippedStatusOf({ recalled, eligible }) {
  if (!recalled) return `${PREFIX} no EvoMap strategy fits this prompt`;
  const why = eligible ? 'none has enough steps to follow' : 'none is relevant enough or new to this session';
  return `${PREFIX} none injected: the Hub returned ${recalled}, ${why}`;
}

/** The status line for a recall's last trace (`recallStrategy`'s `onTrace`), or null for one it does not describe. */
export function recallStatusOf(trace) {
  switch (trace?.outcome) {
    case 'injected':
      return trace.kind === 'recipe'
        ? `${PREFIX} injected Recipe ${quoted(trace.name)} (${trace.steps} steps)`
        : `${PREFIX} injected ${quoted(trace.name)} (the Hub returned ${trace.recalled})`;
    case 'skipped':
      return skippedStatusOf(trace);
    case 'unavailable':
      return `${PREFIX} recall skipped: the Evolver Proxy did not answer (/evolver-status)`;
    case 'short':
      return `${PREFIX} prompt too short to recall for`;
    default:
      return null;
  }
}

/** The status line for a strategy that landed once its turn had ended, so it was never added. */
export const arrivedLateStatusOf = (name) => `${PREFIX} ${quoted(name)} arrived after this turn ended, not injected`;
