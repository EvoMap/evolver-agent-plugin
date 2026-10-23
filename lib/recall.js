// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withoutSecrets } from './redact.js';
import { expandedRecipe, rankedRecipes, recipeSearchRequestOf, stepFetchRequestOf } from './recipe.js';
import { MIN_RELEVANCE, relevanceOf, sharedTerms } from './relevance.js';

// `/asset/fetch` with text and no ids recalls whole assets in one round trip.
// No limit is sent: the Hub's default for a text recall (two assets) applies,
// and the Hub charges per asset it returns, so asking for more costs credits a
// new account may not have.
const MIN_PROMPT_CHARS = 8;
const PROMPT_MAX_CHARS = 400;
// One strategy should read as an approach, not a transcript; a candidate that
// would inject more than this is passed over for the next.
const MAX_INJECTED_CHARS = 4000;
const STEP_MAX_CHARS = 400;
const TITLE_MAX_CHARS = 80;
const DEFAULT_MIN_SIMILARITY = 0.3;
// Text recall skips the Hub's search tuning, so it returns genes too thin to
// follow: two or three steps say too little to reuse. Longer strategies are
// kept whole, each step capped at STEP_MAX_CHARS.
const MIN_STRATEGY_STEPS = 4;
const UNSCORED = -1;
const EMPTY_MATCH = { ids: [], text: '' };

export function strategySteps(asset) {
  const steps = asset?.strategy ?? asset?.payload?.strategy ?? asset?.gene?.strategy;
  const list = Array.isArray(steps) ? steps : [steps];
  return list
    .filter((step) => typeof step === 'string' && step.trim())
    .map((step) => step.trim().slice(0, STEP_MAX_CHARS));
}

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

const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const MIN_CJK_TITLE_CHARS = 5;

function trimmedText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

// A Hub short_title is sometimes a truncated fragment: `Object`, `自动化小`.
// Character count cannot separate those from a good title, because `智能缓存优化`
// says as much in six characters as a Latin title says in forty.
function looksLikeAName(text) {
  if (!text) return false;
  if (CJK_SCRIPT.test(text)) return [...text].length >= MIN_CJK_TITLE_CHARS;
  return /\s/.test(text);
}

export function readableNameOf(asset) {
  const title = trimmedText(asset?.short_title);
  if (looksLikeAName(title)) return title.slice(0, TITLE_MAX_CHARS);
  const described = trimmedText(asset?.nl_summary) || trimmedText(asset?.summary);
  if (described) return described.slice(0, TITLE_MAX_CHARS);
  return title || asset?.asset_type || asset?.type || 'Gene';
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

async function proxyData(proxyFetch, { method, path, body }) {
  try {
    const result = await proxyFetch(method, path, body);
    return result?.ok ? result.data : null;
  } catch {
    return null;
  }
}

// A Recipe is an ordered chain of strategies; one that fits the prompt says
// more than any single step of it, so it is offered first. Its steps are
// fetched by id through the same `/asset/fetch`, priced per asset as any
// fetch is, and a chain with a missing required step is passed over whole.
async function recalledRecipe(proxyFetch, text, listedIds) {
  const found = await proxyData(proxyFetch, recipeSearchRequestOf(text));
  for (const candidate of rankedRecipes(text, found, listedIds)) {
    const fetched = await proxyData(proxyFetch, stepFetchRequestOf(candidate.steps));
    const assetsById = new Map(recalledAssets(fetched).map((asset) => [asset.asset_id, asset]));
    const expanded = expandedRecipe(candidate, assetsById, { strategySteps, readableNameOf });
    if (expanded) return { ...expanded, relevance: candidate.relevance };
  }
  return null;
}

// Picks one strategy for the prompt, or none. An unreachable Proxy, a slow Hub
// or a malformed body yields none rather than an error: recall must never cost
// the turn. Only the steps are injected — a summary tells the model something
// exists, the steps are what it can reuse. `onTrace` hears how the decision was
// made, so it can be shown or kept without reaching the model.
export async function recallStrategy(proxyFetch, text, { listedIds = new Set(), minSimilarity = DEFAULT_MIN_SIMILARITY, onTrace = (_trace) => {} } = {}) {
  if (text.length < MIN_PROMPT_CHARS) {
    onTrace({ outcome: 'short' });
    return EMPTY_MATCH;
  }

  const [recipe, recalled] = await Promise.all([
    recalledRecipe(proxyFetch, text, listedIds),
    proxyData(proxyFetch, { method: 'POST', path: '/asset/fetch', body: { text } }),
  ]);
  if (recipe) {
    const { relevance, ...match } = recipe;
    onTrace({ outcome: 'injected', kind: 'recipe', name: match.name, steps: match.ids.length, relevance });
    return match;
  }
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
    const injected = [
      `[Evolution Memory] ${name} (EvoMap network):`,
      ...steps.map((step, index) => `${index + 1}. ${step}`),
      '',
      `Apply it where it fits. Evolver reports how the reuse of ${candidate.asset_id} went when this turn ends.`,
    ].join('\n');
    if (injected.length > MAX_INJECTED_CHARS) continue;

    onTrace({ outcome: 'injected', recalled: assets.length, eligible: ranked.length, name, relevance: relevanceOf(sharedTerms(text, candidate)) });
    return { ids: [candidate.asset_id], name, text: injected };
  }
  onTrace({ outcome: 'skipped', recalled: assets.length, eligible: ranked.length, bestRelevance: bestRelevanceOf(text, assets, listedIds) });
  return EMPTY_MATCH;
}
