// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// The Hub reads at most 8 signals of up to 80 characters each (MAX_FETCH_SIGNALS / MAX_SIGNAL_LEN in a2aService).
export const MAX_RECALL_SIGNALS = 8;
const MAX_SIGNAL_CHARS = 80;
const MIN_WORD_CHARS = 4;

const ERROR_NAME = /\b[A-Z][A-Za-z]*(?:Error|Exception)\b|\bE[A-Z]{3,}\b/g;
const WORD = /[A-Za-z][A-Za-z0-9+#._-]*[A-Za-z0-9+#]/g;

// Role and workflow preambles repeat these words in every task, so they would outrank the task's own terms.
const STOPWORDS = new Set(`
about above after again against also among another anything around because been before being below between both
cannot could does doing done down during each either else ever every from further have having here into just like
made make many more most much must need needs none only other ought over same should some such than that their
them then there these they this those through under until upon very want were what when where which while will
with within without would your yours yourself always never please using used uses given following ensure
agent agents assistant user users task tasks request requests help helps provide provided respond response
answer answers question questions instruction instructions step steps work working tool tools note
`.split(/\s+/).filter(Boolean));

function errorNamesOf(text) {
  return [...new Set(text.match(ERROR_NAME) ?? [])];
}

function frequentWordsOf(text) {
  const counts = new Map();
  for (const raw of text.match(WORD) ?? []) {
    const word = raw.toLowerCase();
    if (word.length < MIN_WORD_CHARS || STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([word]) => word);
}

// Content keywords for the Hub's signal channels: error names first, then the task's most repeated terms.
export function recallSignalsOf(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const signals = [];
  const seen = new Set();
  for (const candidate of [...errorNamesOf(text), ...frequentWordsOf(text)]) {
    const key = candidate.toLowerCase();
    if (seen.has(key) || candidate.length > MAX_SIGNAL_CHARS) continue;
    seen.add(key);
    signals.push(candidate);
    if (signals.length === MAX_RECALL_SIGNALS) break;
  }
  return signals;
}
