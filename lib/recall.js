// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { expandedRecipe, omittedNoteOf, rankedRecipes, recipeSearchRequestOf, stepFetchRequestOf } from './recipe.js';
import { withoutSecrets } from './redact.js';
import { headOf, linesWithin, tokensOf } from './token-budget.js';

// `/asset/fetch` with text and no ids recalls whole assets in one round trip.
// No limit is sent: the Hub's default for a text recall (two assets) applies,
// and the Hub charges per asset it returns, so asking for more costs credits a
// new account may not have.
const MIN_PROMPT_CHARS = 8;
const PROMPT_MAX_CHARS = 400;
const TASK_MAX_CHARS = 1500;
// One strategy should read as an approach, not a transcript: a longer one keeps
// its opening and safety lines and as many others as fit.
const MAX_STRATEGY_TOKENS = 1000;
const STEP_MAX_TOKENS = 100;
const TITLE_MAX_CHARS = 80;
const DEFAULT_MIN_SIMILARITY = 0.3;
// Text recall skips the Hub's search tuning, so it returns genes too thin to
// follow: two or three steps say too little to reuse. Longer strategies are
// kept, each step capped at STEP_MAX_TOKENS.
const MIN_STRATEGY_STEPS = 4;
const UNSCORED = -1;
const EMPTY_MATCH = { ids: [], text: '' };

function strategySteps(asset) {
  const steps = asset?.strategy ?? asset?.payload?.strategy ?? asset?.gene?.strategy;
  const list = Array.isArray(steps) ? steps : [steps];
  return list
    .filter((step) => typeof step === 'string' && step.trim())
    .map((step) => headOf(step.trim(), STEP_MAX_TOKENS));
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

export function promptTextOf(text, maxChars = PROMPT_MAX_CHARS) {
  if (typeof text !== 'string') return '';
  return withoutSecrets(text)
    .replace(REMINDER_BLOCK, ' ')
    .replace(MARKUP_TAG, ' ')
    .replace(LINK, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

/** The task a session works on, its first prompt cleaned as a prompt is, for the Hub to judge a recall's fit by. */
export function taskTextOf(text) {
  return promptTextOf(text, TASK_MAX_CHARS);
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

function readableNameOf(asset) {
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
// everything out, so the floor applies only where a score exists. Whether an
// asset fits the task is the Hub's call, made by a model with the task as
// context; counting words the prompt shares with an asset dropped on-topic
// Chinese prompts and every asset described in another language, so the Hub's
// order stands where no score reorders it.
function rankedCandidates(assets, listedIds, minSimilarity) {
  return assets
    .filter((asset) => !listedIds.has(asset.asset_id))
    .filter((asset) => typeof asset.similarity !== 'number' || asset.similarity >= minSimilarity)
    .sort((left, right) => similarityOf(right) - similarityOf(left));
}

async function proxyData(proxyFetch, { method, path, body }) {
  try {
    const result = await proxyFetch(method, path, body);
    return result?.ok ? result.data : null;
  } catch {
    return null;
  }
}

// `context` (`{ task, trigger, language? }`) never recalls: the Hub judges each recalled asset's fit to the task with it.
const textRecallOf = (text, context) => ({ method: 'POST', path: '/asset/fetch', body: context ? { text, context } : { text } });

const headingOf = (name) => `[Evolution Memory] ${name} (EvoMap network):`;
const numbered = (steps) => steps.map((step, index) => `${index + 1}. ${step}`);

function readableStepsOf(data) {
  return new Map(recalledAssets(data).map((asset) => {
    const name = readableNameOf(asset);
    const lines = strategySteps(asset);
    return [asset.asset_id, { name, lines, strategyText: [headingOf(name), ...numbered(lines)].join('\n') }];
  }));
}

async function recalledRecipe(proxyFetch, text, { context, listedIds, closingOf }) {
  if (!context) return null;
  const found = await proxyData(proxyFetch, recipeSearchRequestOf(text, context));
  const [best] = rankedRecipes(found, listedIds);
  if (!best) return null;
  const fetched = await proxyData(proxyFetch, stepFetchRequestOf(best.steps));
  const expanded = expandedRecipe(best, readableStepsOf(fetched), { listedIds, closing: closingOf(best.recipe.id) });
  return { ...expanded, fit: best.fit, id: best.recipe.id };
}

const recipeBy = (recipe, cutoff) => (cutoff ? Promise.race([recipe, cutoff.then(() => null)]) : recipe);

function singleStrategyTextOf(name, steps, assetId, closing) {
  const textOf = (lines, omitted) => [headingOf(name), ...numbered(lines), ...(omitted > 0 ? [omittedNoteOf(omitted, assetId)] : []), '', closing].join('\n');
  const frame = tokensOf(textOf([], 0)) + tokensOf(omittedNoteOf(99, assetId));
  const lines = linesWithin(steps, MAX_STRATEGY_TOKENS - frame);
  return textOf(lines, steps.length - lines.length);
}

function singleStrategyOf(recalled, { listedIds, minSimilarity, closingOf }) {
  const assets = recalledAssets(recalled);
  const ranked = rankedCandidates(assets, listedIds, minSimilarity);
  for (const candidate of ranked) {
    const steps = strategySteps(candidate);
    if (steps.length < MIN_STRATEGY_STEPS) continue;

    const name = readableNameOf(candidate);
    const injected = singleStrategyTextOf(name, steps, candidate.asset_id, closingOf(candidate.asset_id));
    const trace = { outcome: 'injected', recalled: assets.length, eligible: ranked.length, name };
    return { match: { ids: [candidate.asset_id], name, text: injected }, trace };
  }
  return { match: null, trace: { outcome: 'skipped', recalled: assets.length, eligible: ranked.length } };
}

// Picks one strategy for the prompt, or none. A fitting Recipe says more than
// any single step of it, so it comes first when it is ready in time, as one
// strategy whose steps keep their own texts (`stepTexts`, by asset id), which
// name each step in the turn's summary. An unreachable Proxy, a slow Hub or a malformed body yields none
// rather than an error: recall must never cost the turn. Only the steps are
// injected — a summary tells the model something exists, the steps are what it
// can reuse. `onTrace` hears how the decision was made, so it can be shown or
// kept without reaching the model.
const defaultClosing = (assetId) => `Apply it where it fits. Evolver reports how the reuse of ${assetId} went when this turn ends.`;

export async function recallStrategy(proxyFetch, text, { context = null, listedIds = new Set(), minSimilarity = DEFAULT_MIN_SIMILARITY, onTrace = (_trace) => {}, closingOf = defaultClosing, recipeCutoff = null } = {}) {
  if (text.length < MIN_PROMPT_CHARS) {
    onTrace({ outcome: 'short' });
    return EMPTY_MATCH;
  }

  // Both start at once. A Recipe is preferred, but once a single strategy is ready it waits for the Recipe only until
  // `recipeCutoff`, so a slow Recipe search never costs the turn the strategy it would have had without Recipes.
  const recipe = recalledRecipe(proxyFetch, text, { context, listedIds, closingOf });
  const recalled = await proxyData(proxyFetch, textRecallOf(text, context));
  const single = recalled ? singleStrategyOf(recalled, { listedIds, minSimilarity, closingOf }) : null;
  const chain = await (single?.match ? recipeBy(recipe, recipeCutoff) : recipe);
  if (chain?.match) {
    onTrace({ outcome: 'injected', kind: 'recipe', name: chain.match.name, steps: chain.match.ids.length, shortened: chain.shortened, fit: chain.fit });
    return chain.match;
  }
  if (chain?.passedOver) onTrace({ outcome: 'passed_over', kind: 'recipe', id: chain.id, reason: chain.passedOver });
  if (!single) {
    onTrace({ outcome: 'unavailable' });
    return EMPTY_MATCH;
  }
  onTrace(single.trace);
  return single.match ?? EMPTY_MATCH;
}
