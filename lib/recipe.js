// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { linesCostOf, linesWithin, sharesOf, tokensOf } from './token-budget.js';

const SEARCH_LIMIT = 5;
const MIN_RECIPE_STEPS = 2;
// About 8000 characters of English, 2000 of Chinese: room for every step's opening and safety lines in a chain of
// ten, where a fixed 6000 characters held no chain of three distilled steps.
const MAX_RECIPE_TOKENS = 2000;

function recipesOf(data) {
  const found = [data, data?.recipes, data?.results, data?.items, data?.payload?.recipes].find(Array.isArray) ?? [];
  return found.filter((recipe) => recipe && typeof recipe.id === 'string' && Array.isArray(recipe.steps ?? recipe.genes));
}

function orderedStepsOf(recipe) {
  const steps = (recipe.steps ?? recipe.genes)
    .filter((step) => typeof (step?.asset_id ?? step?.gene_asset_id) === 'string')
    .map((step) => ({ assetId: step.asset_id ?? step.gene_asset_id, position: Number(step.position) || 0, optional: step.optional === true }))
    .sort((left, right) => left.position - right.position);
  const seen = new Set();
  return steps.filter((step) => !seen.has(step.assetId) && seen.add(step.assetId));
}

// Only required steps decide: an optional step the Hub did not return stays unlisted once the chain is booked, and
// must not bring the chain back, fetched and billed again, at every later prompt.
function hasUnlistedStep(steps, listedIds) {
  const required = steps.filter((step) => !step.optional);
  return (required.length > 0 ? required : steps).some((step) => !listedIds.has(step.assetId));
}

const isJudged = (data) => Number.isFinite(data?.context_fit?.judged);

/**
 * The Recipes of a search answer the Hub judged to fit the caller's task, offering a step the session has not seen,
 * best fit first; none from an unjudged answer. Recipe search alone has no relevance floor, and a few shared words
 * let chains about unrelated work through, so only the Hub's judgement against the task admits one.
 */
export function rankedRecipes(data, listedIds) {
  if (!isJudged(data)) return [];
  return recipesOf(data)
    .filter((recipe) => Number.isFinite(recipe.context_fit))
    .map((recipe) => ({ recipe, steps: orderedStepsOf(recipe), fit: recipe.context_fit }))
    .filter(({ steps }) => steps.length >= MIN_RECIPE_STEPS && hasUnlistedStep(steps, listedIds))
    .sort((left, right) => right.fit - left.fit || (Number(right.recipe.success_rate) || 0) - (Number(left.recipe.success_rate) || 0));
}

const numbered = (lines) => lines.map((line, index) => `${index + 1}. ${line}`);

function shownStepsOf(steps, stepsById) {
  const shown = [];
  for (const step of steps) {
    const found = stepsById.get(step.assetId);
    if (found && found.lines.length > 0) shown.push({ assetId: step.assetId, ...found });
    else if (!step.optional) return [];
  }
  return shown;
}

export const omittedNoteOf = (count, assetId) => `(${count} more lines of ${assetId} left out for length.)`;

function recipeTextOf(name, steps, closing) {
  return [
    `[Evolution Memory] Recipe: ${name} (EvoMap network, ${steps.length} steps, in order):`,
    ...steps.flatMap((step, index) => [
      '',
      `Step ${index + 1} — ${step.name}:`,
      ...numbered(step.lines),
      ...(step.omitted > 0 ? [omittedNoteOf(step.omitted, step.assetId)] : []),
    ]),
    '',
    `Follow the steps in order. ${closing}`,
  ].join('\n');
}

// Every step keeps a share of the budget rather than the chain being dropped whole: a step that needs less than an
// even share keeps all its lines, and a longer one keeps what fits, the lines it left out named by its asset id.
function fittedStepsOf(shown, name, closing) {
  const frame = recipeTextOf(name, shown.map((step) => ({ ...step, lines: [], omitted: 0 })), closing);
  const notes = shown.reduce((sum, step) => sum + tokensOf(omittedNoteOf(99, step.assetId)), 0);
  const shares = sharesOf(shown.map((step) => linesCostOf(step.lines)), MAX_RECIPE_TOKENS - tokensOf(frame) - notes);
  return shown.map((step, index) => {
    const lines = linesWithin(step.lines, shares[index]);
    return { ...step, lines, omitted: step.lines.length - lines.length };
  });
}

/**
 * One injected strategy from a Recipe's steps, in order, each `stepsById` entry `{ name, lines, strategyText }`, as
 * `{ match }`; `{ passedOver }` names why there is none: a required step is missing, too few steps are left, none is
 * new to the session, or not even each step's opening line fits. Each step keeps its own `strategyText`, so the turn's
 * end reports every step's reuse on its own.
 */
export function expandedRecipe({ recipe, steps }, stepsById, { listedIds, closing }) {
  const shown = shownStepsOf(steps, stepsById);
  if (shown.length < MIN_RECIPE_STEPS) return { passedOver: 'missing_steps' };
  if (shown.every((step) => listedIds.has(step.assetId))) return { passedOver: 'seen' };
  const name = (typeof recipe.title === 'string' && recipe.title.trim()) || recipe.id;
  const fitted = fittedStepsOf(shown, name, closing);
  if (fitted.some((step) => step.lines.length === 0)) return { passedOver: 'too_long' };
  return {
    match: {
      ids: fitted.map((step) => step.assetId),
      name,
      text: recipeTextOf(name, fitted, closing),
      stepTexts: Object.fromEntries(fitted.map((step) => [step.assetId, step.strategyText])),
    },
    shortened: fitted.filter((step) => step.omitted > 0).length,
  };
}

export function recipeSearchRequestOf(text, context) {
  return { method: 'POST', path: '/recipe/search', body: { q: text, limit: SEARCH_LIMIT, context } };
}

export function stepFetchRequestOf(steps) {
  return { method: 'POST', path: '/asset/fetch', body: { asset_ids: steps.map((step) => step.assetId) } };
}
