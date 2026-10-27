// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { MIN_RELEVANCE, relevanceOf, sharedTerms } from './relevance.js';
import { numberedSteps, readableNameOf, strategyBlockOf, strategySteps } from './strategy-text.js';

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

const selfDescriptionOf = (recipe) => ({ short_title: recipe.title, summary: recipe.description });

// An optional step may be missing from what was shown, so only a required step the session has not seen yet makes
// the Recipe new to it; otherwise one shown once would be fetched again on every later prompt.
const isNewTo = (listedIds) => (step) => !step.optional && !listedIds.has(step.assetId);

/**
 * The Recipes in a `/recipe/search` answer worth expanding for `text`, best first. Search returns only a Recipe's
 * title and description, so those carry the same relevance gate a single strategy's own description does.
 */
export function rankedRecipes(text, data, listedIds) {
  return recipesOf(data)
    .map((recipe) => ({ recipe, steps: orderedStepsOf(recipe), relevance: relevanceOf(sharedTerms(text, selfDescriptionOf(recipe))) }))
    .filter(({ steps, relevance }) => steps.length >= MIN_RECIPE_STEPS && relevance >= MIN_RELEVANCE)
    .filter(({ steps }) => steps.some(isNewTo(listedIds)))
    .sort((left, right) => right.relevance - left.relevance || (Number(right.recipe.success_rate) || 0) - (Number(left.recipe.success_rate) || 0));
}

function shownStepsOf(steps, assetsById) {
  const shown = [];
  for (const step of steps) {
    const asset = assetsById.get(step.assetId);
    const lines = asset ? strategySteps(asset) : [];
    if (lines.length > 0) shown.push({ assetId: step.assetId, name: readableNameOf(asset), lines });
    else if (!step.optional) return null;
  }
  return shown;
}

/**
 * A ranked Recipe as one injection, its steps in order under a heading each, or null when a required step's asset is
 * missing or the whole would be too long to read as one approach. Each step is an asset reused on its own:
 * `stepTexts` holds the strategy each step's id is booked under.
 */
export function expandedRecipe({ recipe, steps }, assetsById, closing) {
  const shown = shownStepsOf(steps, assetsById);
  if (!shown || shown.length < MIN_RECIPE_STEPS) return null;
  const name = (typeof recipe.title === 'string' && recipe.title.trim()) || recipe.id;
  const text = [
    `[Evolution Memory] Recipe: ${name} (EvoMap network, ${shown.length} steps, in order):`,
    ...shown.flatMap((step, index) => ['', `Step ${index + 1} — ${step.name}:`, numberedSteps(step.lines)]),
    '',
    closing,
  ].join('\n');
  if (text.length > MAX_RECIPE_CHARS) return null;
  return {
    ids: shown.map((step) => step.assetId),
    name,
    text,
    stepTexts: Object.fromEntries(shown.map((step) => [step.assetId, strategyBlockOf(step.name, step.lines)])),
  };
}

export function recipeSearchRequestOf(text) {
  return { method: 'POST', path: '/recipe/search', body: { q: text, limit: SEARCH_LIMIT } };
}

export function stepFetchRequestOf(steps) {
  return { method: 'POST', path: '/asset/fetch', body: { asset_ids: steps.map((step) => step.assetId) } };
}
