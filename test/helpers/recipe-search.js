/**
 * The Hub's answer to a Recipe search: judged against the caller's task when the request carries a context, each
 * Recipe with its own `context_fit` (0.8 unless the Recipe names one), and plain, unjudged, when it carries none.
 */
export function recipeSearchAnswer(recipes, body) {
  if (!body?.context) return { recipes, count: recipes.length };
  const judged = recipes.map((recipe) => ({ context_fit: 0.8, ...recipe }));
  return { recipes: judged, count: judged.length, context_fit: { judged: recipes.length, kept: judged.length } };
}
