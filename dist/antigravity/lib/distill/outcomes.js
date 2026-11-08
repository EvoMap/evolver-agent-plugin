// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// Every distillation leaves a trace the person can see, including those that never reached a model: the last
// MAX_OUTCOMES per agent, newest last.

export const MAX_OUTCOMES = 20;

/** The log with `entry` (`{ status, reason?, detail?, terms?, by?, title?, session, trigger, at }`) added. */
export const withOutcome = (log, entry) => [...(Array.isArray(log) ? log : []), entry].slice(-MAX_OUTCOMES);

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function agoOf(ms) {
  if (!(ms >= MINUTE)) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`;
  if (ms < 48 * HOUR) return `${Math.floor(ms / HOUR)} h ago`;
  return `${Math.floor(ms / (24 * HOUR))} d ago`;
}

const reasonOf = ({ reason, terms }) => `${reason}${terms?.length ? `: ${terms.join(', ')}` : ''}`;

const PHRASES = {
  stored: (entry) => `stored "${entry.title}"`,
  drafted: (entry) => `drafted "${entry.title}", waiting in /evolver-drafts`,
  rejected: (entry) => `rejected by ${entry.by === 'plugin' ? 'the plugin\'s shape check' : 'the Proxy'} (${reasonOf(entry)})`,
  declined: (entry) => `declined by the model (${entry.reason})`,
  below_threshold: (entry) => `below the threshold, no model call (${entry.detail ?? entry.reason})`,
  failed: (entry) => `failed (${entry.reason}${entry.error ? `: ${entry.error}` : ''})`,
  blocked: (entry) => `blocked, the session's model route is unavailable (${entry.reason})`,
  dropped: () => 'discarded, the work it read changed while it ran',
  superseded: (entry) => `"${entry.title}" not kept, a newer draft with the same ID is saved`,
  draft_missing: (entry) => `"${entry.title}" drafted, but the draft is gone`,
  cleanup_failed: (entry) => `"${entry.title}" invalidated by a correction; discard its draft in /evolver-drafts`,
};

/** The newest outcome in one line, naming its reason and terms, e.g. "rejected by the Proxy (too_project_specific: x)". */
export function lastOutcomeText(log, now) {
  const last = Array.isArray(log) ? log.at(-1) : null;
  if (!last) return 'No distillation has run yet.';
  const phrase = PHRASES[last.status]?.(last) ?? last.status;
  return `Last distillation: ${phrase}, ${agoOf(now - Number(last.at))}.`;
}
