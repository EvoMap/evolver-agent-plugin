// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// The one line a host pins under its prompt while a turn runs: what the recall for that turn decided, including the
// recalls that injected nothing, so a quiet turn is told apart from one that never recalled. The host already heads
// the line with the plugin's name, and draws it narrow and unstyled: a leading mark carries the decision at a glance,
// and the strategy's name, the part most often cut, comes last.

const NAME_MAX_CHARS = 32;

const quoted = (name) => {
  const text = String(name ?? 'EvoMap strategy');
  return `"${text.length > NAME_MAX_CHARS ? `${text.slice(0, NAME_MAX_CHARS - 1)}…` : text}"`;
};

export const RECALLING_STATUS = '⟳ recalling an EvoMap strategy…';

function skippedStatusOf({ recalled, eligible }) {
  if (!recalled) return '○ no EvoMap strategy fits this prompt';
  const why = eligible ? 'none has enough steps' : 'none relevant or new';
  return `○ none injected · Hub returned ${recalled}, ${why}`;
}

/** The status line for a recall's last trace (`recallStrategy`'s `onTrace`); any other recall injected nothing. */
export function recallStatusOf(trace) {
  switch (trace?.outcome) {
    case 'injected':
      return trace.kind === 'recipe'
        ? `✓ injected Recipe ${quoted(trace.name)} · ${trace.steps} steps`
        : `✓ injected ${quoted(trace.name)}`;
    case 'skipped':
      return skippedStatusOf(trace);
    case 'unavailable':
      return '! recall skipped · Evolver Proxy did not answer (/evolver-status)';
    case 'short':
      return '○ prompt too short to recall for';
    default:
      return '○ no EvoMap strategy injected';
  }
}

/** The status line for a strategy that landed once its turn had ended, so it was never added. */
export const arrivedLateStatusOf = (name) => `○ ${quoted(name)} arrived after the turn ended, not injected`;

/**
 * The notice for a turn that reported no strategy, headed like the turn summary, so every recalled-for turn ends saying
 * what its recall did: `isSettled` whether the recall had decided by then, `isJoined` whether a model step carried
 * what it injected.
 */
export function unreportedTurnNoticeOf({ trace, isSettled, isJoined }) {
  return `Evolver · ${unreportedDecisionOf({ trace, isSettled, isJoined })}`;
}

function unreportedDecisionOf({ trace, isSettled, isJoined }) {
  if (!isSettled) return '! recall had not finished when this turn ended, nothing injected';
  if (trace?.outcome === 'injected' && !isJoined) return `○ ${quoted(trace.name)} was recalled after the model's last step, so this turn did not use it`;
  return recallStatusOf(trace);
}
