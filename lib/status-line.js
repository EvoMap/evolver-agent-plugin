// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { MIN_RELEVANCE } from './relevance.js';

const NAME_MAX_CHARS = 40;
const LINE_MAX_CHARS = 160;

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function recallStatusOf(trace) {
  switch (trace?.outcome) {
    case 'short':
      return 'recall: prompt too short';
    case 'unavailable':
      return 'recall: Proxy gave no answer';
    case 'waiting':
      return `recall: still waiting after ${Math.round(trace.waitedMs / 1000)}s, lands next step`;
    case 'dropped':
      return 'recall: arrived after the turn was interrupted, dropped';
    case 'injected':
      return `recall: injected "${String(trace.name).slice(0, NAME_MAX_CHARS)}" (${plural(trace.recalled, 'hit')}, relevance ${trace.relevance})`;
    case 'skipped':
      return trace.recalled === 0
        ? 'recall: no assets came back'
        : `recall: ${plural(trace.recalled, 'hit')}, best relevance ${trace.bestRelevance} (needs ${MIN_RELEVANCE}), none injected`;
    default:
      return null;
  }
}

export function statusLineOf(parts) {
  const shown = parts.filter(Boolean);
  return shown.length === 0 ? undefined : `evolver · ${shown.join(' · ')}`.slice(0, LINE_MAX_CHARS);
}
