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

const selfDescriptionOf = (recipe) => ({ short_title: recipe.title, summary: recipe.description });

// A Recipe's title and description are all search returns about it, so they
// carry the same relevance gate a single strategy's own description does.
export function rankedRecipes(text, data, listedIds) {
  return recipesOf(data)
    .map((recipe) => ({ recipe, steps: orderedStepsOf(recipe), relevance: relevanceOf(sharedTerms(text, selfDescriptionOf(recipe))) }))
    .filter(({ steps, relevance }) => steps.length >= MIN_RECIPE_STEPS && relevance >= MIN_RELEVANCE)
    .filter(({ steps }) => steps.some((step) => !listedIds.has(step.assetId)))
    .sort((left, right) => right.relevance - left.relevance || (Number(right.recipe.success_rate) || 0) - (Number(left.recipe.success_rate) || 0));
}

function numbered(steps) {
  return steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
}

// Each step is shown under its own heading with its own numbered steps, and
// each step's text is kept apart so the turn's end judges every step's reuse
// on its own, the same way a single strategy is judged.
export function expandedRecipe({ recipe, steps }, assetsById, { strategySteps, readableNameOf }) {
  const shown = [];
  for (const step of steps) {
    const asset = assetsById.get(step.assetId);
    const lines = asset ? strategySteps(asset) : [];
    if (lines.length === 0) {
      if (step.optional) continue;
      return null;
    }
    shown.push({ assetId: step.assetId, name: readableNameOf(asset), lines });
  }
  if (shown.length < MIN_RECIPE_STEPS) return null;
  const name = String(recipe.title ?? recipe.id).trim();
  const text = [
    `[Evolution Memory] Recipe: ${name} (EvoMap network, ${shown.length} steps, in order):`,
    ...shown.flatMap((step, index) => ['', `Step ${index + 1} — ${step.name}:`, numbered(step.lines)]),
    '',
    `Apply the steps in order where they fit. Evolver reports how the reuse of recipe ${recipe.id} went when this turn ends.`,
  ].join('\n');
  if (text.length > MAX_RECIPE_CHARS) return null;
  return {
    ids: shown.map((step) => step.assetId),
    name,
    recipeId: recipe.id,
    text,
    stepTexts: Object.fromEntries(shown.map((step) => [step.assetId, numbered(step.lines)])),
  };
}

export function recipeSearchRequestOf(text) {
  return { method: 'POST', path: '/recipe/search', body: { q: text, limit: SEARCH_LIMIT } };
}

export function stepFetchRequestOf(steps) {
  return { method: 'POST', path: '/asset/fetch', body: { asset_ids: steps.map((step) => step.assetId) } };
}
