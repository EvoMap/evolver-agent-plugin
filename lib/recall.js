// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { recallSignalsOf } from './recall-signals.js';
import { expandedRecipe, omittedNoteOf, rankedRecipes, recipeSearchRequestOf, stepFetchRequestOf } from './recipe.js';
import { withoutSecrets } from './redact.js';
import { requiredSkillLinesOf } from './required-skills.js';
import { MAX_RECENT_TURNS } from './session/state.js';
import { headOf, linesWithin, tokensOf } from './token-budget.js';

// `/asset/fetch` with text and no ids recalls whole assets in one round trip.
// No limit is sent: the Hub's default for a text recall (two assets) applies,
// and the Hub charges per asset it returns, so asking for more costs credits a
// new account may not have.
const MIN_PROMPT_CHARS = 8;
// Prompts often open with a role or workflow preamble shared by every task of a
// kind; at 400 characters the recall text was that preamble and nothing else.
const PROMPT_MAX_CHARS = 2000;
const TASK_MAX_CHARS = 4000;
// The Evolver Proxy drops a recall context whose JSON is over 16 KiB whole (4096 bytes up to 2.0.48; the plugin
// requires 2.0.50), and the Hub then judges nothing.
const PROXY_CONTEXT_MAX_BYTES = 16_384;
// A short follow-up ("how many assets in all?") says little alone: the turns before it, and what the agent last
// answered, say what it refers to. Each answer keeps its opening, where an agent states the outcome.
const RECENT_PROMPT_MAX_CHARS = 500;
const RECENT_ANSWER_MAX_CHARS = 800;
const RECENT_TURNS_MAX_CHARS = 4000;
const SESSION_TITLE_MAX_CHARS = 120;
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
  for (const strategy of [asset?.strategy, asset?.payload?.strategy, asset?.gene?.strategy, asset?.a2a?.context_projection?.strategy]) {
    const steps = Array.isArray(strategy) ? strategy : [strategy];
    const lines = steps
      .filter((step) => typeof step === 'string' && step.trim())
      .map((step) => headOf(step.trim(), STEP_MAX_TOKENS));
    if (lines.length > 0) return lines;
  }
  return [];
}

function isCapsuleAsset(asset) {
  const kind = asset?.type ?? asset?.asset_type ?? asset?.assetType;
  return kind === 'Capsule';
}

function capsuleFallbackLines(asset) {
  if (!isCapsuleAsset(asset)) return [];
  const lines = [];
  const summary = trimmedText(asset?.summary) || trimmedText(asset?.a2a?.context_projection?.summary);
  if (summary) lines.push(headOf(withoutSecrets(`Verified case: ${summary}`), STEP_MAX_TOKENS));
  const rawTriggers = asset?.trigger ?? asset?.a2a?.context_projection?.trigger;
  const triggers = Array.isArray(rawTriggers)
    ? rawTriggers.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()).slice(0, 6)
    : [];
  if (triggers.length > 0) lines.push(headOf(withoutSecrets(`Applies to signals: ${triggers.join(', ')}`), STEP_MAX_TOKENS));
  const outcome = asset?.outcome;
  if (outcome && typeof outcome.status === 'string' && outcome.status.trim()) {
    const score = typeof outcome.score === 'number' && Number.isFinite(outcome.score)
      ? ` (score=${outcome.score.toFixed(2)})`
      : '';
    lines.push(headOf(`Recorded outcome: ${outcome.status.trim()}${score}`, STEP_MAX_TOKENS));
  }
  const trace = Array.isArray(asset?.execution_trace) ? asset.execution_trace : [];
  let addedChecks = 0;
  for (const row of trace) {
    if (addedChecks >= 3) break;
    if (!row || typeof row !== 'object') continue;
    const passed = row.exit === 0 || (row.exit === undefined && row.ok === true);
    const cmd = trimmedText(row.command) || trimmedText(row.cmd) || trimmedText(row.name);
    if (!passed || !cmd) continue;
    lines.push(headOf(withoutSecrets(`Verified check: ${cmd}`), STEP_MAX_TOKENS));
    addedChecks += 1;
  }
  return lines;
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
// host and path words matched assets that only shared a domain. Chinese is
// written right after a link with no space, so a link ends where its URL
// characters do: `官网(https://…/zh)本周上线` keeps `本周上线`. A host may be an
// IDN of dot-joined labels in any script, `sub.例子.测试`, and goes whole; a
// single label is only ASCII, so `https://evomap.ai这个网站` keeps `这个网站`.
// After the host, a non-ASCII run stays in the link where it is a query value
// or fragment (right after `=`, `?`, `#` or `&`: `?q=中文`, `#章节`) or where URL
// structure follows it (`/`, `?`, `#`, `:`, or a dot and a letter of any
// script): a path `/患者/病例?id=1` goes with the link, and its path or query
// never reaches the Hub. A non-ASCII last path segment with nothing after it,
// `/wiki/中文`, cannot be told from the sentence that follows a link, and is
// kept as the person's text.
const REMINDER_BLOCK = /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g;
const MARKUP_TAG = /<\/?[a-z][\w-]*(?:\s[^<>]*)?>/gi;
const NON_ASCII_RUN = '[^\\x00-\\x7F\\s\\u3000-\\u303F\\uFF00-\\uFFEF]+';
const HOST_LABEL = `(?:[A-Za-z0-9-]+|${NON_ASCII_RUN})`;
const DOTTED_HOST = `${HOST_LABEL}(?:\\.${HOST_LABEL})+`;
const URL_ASCII_RUN = "[A-Za-z0-9\\-._~:/?#[\\]@!$&'()*+,;=%]+";
const URL_NON_ASCII_SEGMENT = `(?:(?<=[=?#&])${NON_ASCII_RUN}|${NON_ASCII_RUN}(?=[/?#:]|\\.[\\p{L}\\p{N}]))`;
const LINK = new RegExp(`\\b(?:https?:\\/\\/|www\\.)(?:${DOTTED_HOST})?(?:${URL_ASCII_RUN}|${URL_NON_ASCII_SEGMENT})*`, 'giu');

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

/** A turn's final answer as later recalls see it: its opening, cleaned and redacted as a prompt is. */
export function answerTextOf(text) {
  return promptTextOf(text, RECENT_ANSWER_MAX_CHARS);
}

/** A host's name for the session, cleaned and redacted as a prompt is; '' when it gives none. */
export function sessionTitleOf(text) {
  return promptTextOf(text, SESSION_TITLE_MAX_CHARS);
}

// A turn is a prompt and the answer it got: an answer whose prompt is gone (never recorded, or cleaned to nothing)
// belongs to no turn the Hub can read, so the whole turn is left out.
function messagesOf(turn) {
  const prompt = promptTextOf(turn?.prompt, RECENT_PROMPT_MAX_CHARS);
  if (!prompt) return [];
  return [{ role: 'user', text: prompt }, { role: 'assistant', text: answerTextOf(turn?.answer) }].filter((message) => message.text);
}

/**
 * The session's earlier turns, oldest first, as the `recent_turns` of a recall context: each turn's prompt, then
 * its answer, for the newest turns, at most `MAX_RECENT_TURNS`, that fit whole.
 */
export function recentTurnsOf(turns) {
  const messages = [];
  let total = 0;
  for (const turn of [...(turns ?? [])].slice(-MAX_RECENT_TURNS).reverse()) {
    const ofTurn = messagesOf(turn);
    const size = ofTurn.reduce((sum, message) => sum + message.text.length, 0);
    if (total + size > RECENT_TURNS_MAX_CHARS) break;
    total += size;
    messages.unshift(...ofTurn);
  }
  return messages;
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
// `signals` feed the Hub's signal and domain-signal recall channels, which stay empty without them. `project_dir`
// lets the Proxy recognise the project, so its local project notes and project-bound Genes can be recalled.
function textRecallOf(text, context, projectDir) {
  const signals = recallSignalsOf(text);
  const body = { text, ...(context && { context }), ...(signals.length > 0 && { signals }), ...(projectDir && { project_dir: projectDir }) };
  return { method: 'POST', path: '/asset/fetch', body };
}

const WITHHELD_ID_MAX_CHARS = 200;
const isTextUpTo = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

// The Proxy takes a trial control only under the id of the withholding it answers, so one without that id is no control.
function withheldOf(recalled) {
  const { asset_id: assetId, withheld_id: withheldId } = recalled?.trial_withheld ?? {};
  return typeof assetId === 'string' && assetId && isTextUpTo(withheldId, WITHHELD_ID_MAX_CHARS) ? { asset_id: assetId, withheld_id: withheldId } : null;
}

const contextBytes = (context) => Buffer.byteLength(JSON.stringify(context));

// A turn goes whole: its prompt and the answer to it.
function withoutOldestTurn(messages) {
  const rest = messages.slice(1);
  return rest[0]?.role === 'assistant' ? rest.slice(1) : rest;
}

function withoutOldestTurns(context) {
  const fitted = { ...context };
  while (fitted.recent_turns?.length && contextBytes(fitted) > PROXY_CONTEXT_MAX_BYTES) fitted.recent_turns = withoutOldestTurn(fitted.recent_turns);
  if (fitted.recent_turns?.length === 0) delete fitted.recent_turns;
  return fitted;
}

// The task outranks the recent turns: the oldest turns go first, and only then is the task cut.
function withinProxyLimit(full) {
  const context = full ? withoutOldestTurns(full) : full;
  const excess = context?.task ? contextBytes(context) - PROXY_CONTEXT_MAX_BYTES : 0;
  if (excess <= 0) return context;
  const task = Buffer.from(context.task);
  return { ...context, task: new TextDecoder().decode(task.subarray(0, Math.max(0, task.length - excess))).replace(/\uFFFD+$/u, '') };
}

const headingOf = (name) => `[Evolution Memory] ${name} (EvoMap network):`;
const numbered = (steps) => steps.map((step, index) => `${index + 1}. ${step}`);

function readableStepsOf(data) {
  return new Map(recalledAssets(data).map((asset) => {
    const name = readableNameOf(asset);
    const directLines = strategySteps(asset);
    const lines = directLines.length > 0 ? directLines : capsuleFallbackLines(asset);
    // The step's own text is what the session ledger keeps for this Gene, so it names the pinned skill as the
    // injected Recipe does.
    const skillLines = requiredSkillLinesOf(asset);
    return [asset.asset_id, { name, lines, skillLines, strategyText: [headingOf(name), ...numbered(lines), ...skillLines].join('\n') }];
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

// A pinned skill's lines follow the steps, outside the cut: a strategy without the skill it needs is incomplete.
function singleStrategyTextOf(name, steps, assetId, closing, skillLines = []) {
  const textOf = (lines, omitted) => [headingOf(name), ...numbered(lines), ...(omitted > 0 ? [omittedNoteOf(omitted, assetId)] : []), ...skillLines, '', closing].join('\n');
  const frame = tokensOf(textOf([], 0)) + tokensOf(omittedNoteOf(99, assetId));
  const lines = linesWithin(steps, MAX_STRATEGY_TOKENS - frame);
  if (lines.length === 0) return '';
  return textOf(lines, steps.length - lines.length);
}

function singleStrategyOf(recalled, { listedIds, minSimilarity, closingOf }) {
  const assets = recalledAssets(recalled);
  const ranked = rankedCandidates(assets, listedIds, minSimilarity);
  for (const candidate of ranked) {
    const steps = strategySteps(candidate);
    // A Gene that pins a skill keeps its detail in the skill, so a short strategy is all it needs.
    const skillLines = requiredSkillLinesOf(candidate);
    if (steps.length < (skillLines.length > 0 ? 1 : MIN_STRATEGY_STEPS)) continue;

    const name = readableNameOf(candidate);
    const injected = singleStrategyTextOf(name, steps, candidate.asset_id, closingOf(candidate.asset_id), skillLines);
    if (!injected) continue;
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

// `onWithheld({ asset_id, withheld_id })` hears of a trial Gene the Proxy held back from this recall to measure it
// against, and of the withholding's id its control is reported under.
export async function recallStrategy(proxyFetch, text, { context = null, projectDir = null, listedIds = new Set(), minSimilarity = DEFAULT_MIN_SIMILARITY, onTrace = (_trace) => {}, onWithheld = (_withheld) => {}, closingOf = defaultClosing, recipeCutoff = null } = {}) {
  if (text.length < MIN_PROMPT_CHARS) {
    onTrace({ outcome: 'short' });
    return EMPTY_MATCH;
  }

  // Both start at once. A Recipe is preferred, but once a single strategy is ready it waits for the Recipe only until
  // `recipeCutoff`, so a slow Recipe search never costs the turn the strategy it would have had without Recipes.
  const sent = withinProxyLimit(context);
  const recipe = recalledRecipe(proxyFetch, text, { context: sent, listedIds, closingOf });
  const recalled = await proxyData(proxyFetch, textRecallOf(text, sent, projectDir));
  const withheld = withheldOf(recalled);
  if (withheld) await onWithheld(withheld);
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
