// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withoutSecrets } from './redact.js';
import { MIN_RELEVANCE, relevanceOf, sharedTerms } from './relevance.js';
import { readableNameOf, strategyBlockOf, strategySteps } from './strategy-text.js';

// `/asset/fetch` with text and no ids recalls whole assets in one round trip.
// No limit is sent: the Hub's default for a text recall (two assets) applies,
// and the Hub charges per asset it returns, so asking for more costs credits a
// new account may not have.
const MIN_PROMPT_CHARS = 8;
const PROMPT_MAX_CHARS = 400;
// One strategy should read as an approach, not a transcript; a candidate that
// would inject more than this is passed over for the next.
const MAX_INJECTED_CHARS = 4000;
const DEFAULT_MIN_SIMILARITY = 0.3;
// Text recall skips the Hub's search tuning, so it returns genes too thin to
// follow: two or three steps say too little to reuse. Longer strategies are
// kept whole, each step capped in length.
const MIN_STRATEGY_STEPS = 4;
const UNSCORED = -1;
const EMPTY_MATCH = { ids: [], text: '' };

// Only what the person typed is matched: notifications, peer messages and other
// plugins' prompts are not the person's task, and Claude Code's own reminders
// would drown the task in boilerplate.
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'scheduled-trigger']);

export function isPersonPrompt(origin) {
  return origin === undefined || PERSON_ORIGINS.has(origin?.kind);
}

// Engine reminders, task markup and links are not what the person asked:
// a session notification is nothing but a `<system-reminder>`, and a link's
// host and path words matched assets that only shared a domain.
const REMINDER_BLOCK = /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g;
const MARKUP_TAG = /<\/?[a-z][\w-]*(?:\s[^<>]*)?>/gi;
const LINK = /\b(?:https?:\/\/|www\.)\S+/gi;

export function promptTextOf(text) {
  if (typeof text !== 'string') return '';
  return withoutSecrets(text)
    .replace(REMINDER_BLOCK, ' ')
    .replace(MARKUP_TAG, ' ')
    .replace(LINK, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PROMPT_MAX_CHARS);
}

function recalledAssets(data) {
  const found = [data?.assets, data?.results, data?.payload?.results].find(Array.isArray) ?? [];
  return found.filter((asset) => asset && typeof asset.asset_id === 'string' && asset.asset_id);
}

function similarityOf(asset) {
  return typeof asset.similarity === 'number' ? asset.similarity : UNSCORED;
}

// A Proxy's similarity score is advisory — the same question scored 0.88 asked
// one way and 0.40 another — and a Proxy that reports none must not filter
// everything out, so the floor applies only where a score exists. Relevance to
// the prompt gates every candidate and breaks ties; the Hub's own order is not
// trusted, since it weighs more than this prompt.
function rankedCandidates(text, assets, listedIds, minSimilarity) {
  return assets
    .filter((asset) => !listedIds.has(asset.asset_id))
    .filter((asset) => typeof asset.similarity !== 'number' || asset.similarity >= minSimilarity)
    .map((asset) => ({ asset, relevance: relevanceOf(sharedTerms(text, asset)) }))
    .filter(({ relevance }) => relevance >= MIN_RELEVANCE)
    .sort((left, right) => similarityOf(right.asset) - similarityOf(left.asset) || right.relevance - left.relevance)
    .map(({ asset }) => asset);
}

function bestRelevanceOf(text, assets, listedIds) {
  return assets
    .filter((asset) => !listedIds.has(asset.asset_id))
    .reduce((best, asset) => Math.max(best, relevanceOf(sharedTerms(text, asset))), 0);
}

async function recalledData(proxyFetch, text) {
  try {
    const result = await proxyFetch('POST', '/asset/fetch', { text });
    return result?.ok ? result.data : null;
  } catch {
    return null;
  }
}

// Picks one strategy for the prompt, or none. An unreachable Proxy, a slow Hub
// or a malformed body yields none rather than an error: recall must never cost
// the turn. Only the steps are injected — a summary tells the model something
// exists, the steps are what it can reuse. `onTrace` hears how the decision was
// made, so it can be shown or kept without reaching the model.
const defaultClosing = (assetId) => `Apply it where it fits. Evolver reports how the reuse of ${assetId} went when this turn ends.`;

export async function recallStrategy(proxyFetch, text, { listedIds = new Set(), minSimilarity = DEFAULT_MIN_SIMILARITY, onTrace = (_trace) => {}, closingOf = defaultClosing } = {}) {
  if (text.length < MIN_PROMPT_CHARS) {
    onTrace({ outcome: 'short' });
    return EMPTY_MATCH;
  }

  const recalled = await recalledData(proxyFetch, text);
  if (!recalled) {
    onTrace({ outcome: 'unavailable' });
    return EMPTY_MATCH;
  }

  const assets = recalledAssets(recalled);
  const ranked = rankedCandidates(text, assets, listedIds, minSimilarity);
  for (const candidate of ranked) {
    const steps = strategySteps(candidate);
    if (steps.length < MIN_STRATEGY_STEPS) continue;

    const name = readableNameOf(candidate);
    const injected = [strategyBlockOf(name, steps), '', closingOf(candidate.asset_id)].join('\n');
    if (injected.length > MAX_INJECTED_CHARS) continue;

    onTrace({ outcome: 'injected', recalled: assets.length, eligible: ranked.length, name, relevance: relevanceOf(sharedTerms(text, candidate)) });
    return { ids: [candidate.asset_id], name, text: injected };
  }
  onTrace({ outcome: 'skipped', recalled: assets.length, eligible: ranked.length, bestRelevance: bestRelevanceOf(text, assets, listedIds) });
  return EMPTY_MATCH;
}
