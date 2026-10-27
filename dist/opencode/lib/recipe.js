// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { MIN_RELEVANCE, relevanceOf, sharedTerms } from './relevance.js';

const SEARCH_LIMIT = 5;
const MIN_RECIPE_STEPS = 2;
const MAX_RECIPE_CHARS = 6000;

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

// A Recipe's title and description are all search returns about it, so they pass the same relevance gate a single
// strategy's own description does.
const relevanceTo = (text, recipe) => relevanceOf(sharedTerms(text, { short_title: recipe.title, summary: recipe.description }));

// Only required steps decide: an optional step the Hub did not return stays unlisted once the chain is booked, and
// must not bring the chain back, fetched and billed again, at every later prompt.
function hasUnlistedStep(steps, listedIds) {
  const required = steps.filter((step) => !step.optional);
  return (required.length > 0 ? required : steps).some((step) => !listedIds.has(step.assetId));
}

/** The Recipes of a search answer that fit `text` and offer a step the session has not seen, best first. */
export function rankedRecipes(text, data, listedIds) {
  return recipesOf(data)
    .map((recipe) => ({ recipe, steps: orderedStepsOf(recipe), relevance: relevanceTo(text, recipe) }))
    .filter(({ steps, relevance }) => steps.length >= MIN_RECIPE_STEPS && relevance >= MIN_RELEVANCE)
    .filter(({ steps }) => hasUnlistedStep(steps, listedIds))
    .sort((left, right) => right.relevance - left.relevance || (Number(right.recipe.success_rate) || 0) - (Number(left.recipe.success_rate) || 0));
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

/**
 * One injected strategy from a Recipe's steps, in order, each `stepsById` entry `{ name, lines, strategyText }`; null
 * when a required step is missing, too few steps are left, none is new to the session, or the chain is too long.
 * Each step keeps its own `strategyText`, so the turn's end reports every step's reuse on its own.
 */
export function expandedRecipe({ recipe, steps }, stepsById, { listedIds, closing }) {
  const shown = shownStepsOf(steps, stepsById);
  if (shown.length < MIN_RECIPE_STEPS || shown.every((step) => listedIds.has(step.assetId))) return null;
  const name = (typeof recipe.title === 'string' && recipe.title.trim()) || recipe.id;
  const text = [
    `[Evolution Memory] Recipe: ${name} (EvoMap network, ${shown.length} steps, in order):`,
    ...shown.flatMap((step, index) => ['', `Step ${index + 1} — ${step.name}:`, ...numbered(step.lines)]),
    '',
    `Follow the steps in order. ${closing}`,
  ].join('\n');
  if (text.length > MAX_RECIPE_CHARS) return null;
  return {
    ids: shown.map((step) => step.assetId),
    name,
    text,
    stepTexts: Object.fromEntries(shown.map((step) => [step.assetId, step.strategyText])),
  };
}

export function recipeSearchRequestOf(text) {
  return { method: 'POST', path: '/recipe/search', body: { q: text, limit: SEARCH_LIMIT } };
}

export function stepFetchRequestOf(steps) {
  return { method: 'POST', path: '/asset/fetch', body: { asset_ids: steps.map((step) => step.assetId) } };
}
