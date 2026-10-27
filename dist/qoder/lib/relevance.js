// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// The local Proxy's text recall reports no similarity, so the Hub's own order
// is all that ranks it, and that order put a naming-registry gene behind "还有多少
// 没有对齐？". Terms the prompt shares with what the asset says about itself are
// the relevance evidence left. A Han bigram is weaker evidence than a Latin word:
// "提示" and "注入" are both in a question about a plugin's notice and in a
// prompt-injection security gene, so a bigram weighs half a word. Measured on
// live recalls, every hit that scored 1.5 was off-topic, while on-topic ones
// (a Redis timeout, a React list, a Sentry triage) scored 2 or more.
export const MIN_RELEVANCE = 2;

const HAN_TERM_WEIGHT = 0.5;

const MIN_LATIN_TERM_CHARS = 3;
const MIN_STEM_CHARS = 3;

const LATIN_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'into', 'from', 'when', 'are', 'was', 'not', 'all', 'any',
  'our', 'your', 'its', 'add', 'fix', 'use', 'using', 'make', 'how', 'why', 'what', 'can', 'should',
  // Nearly every asset on the network mentions the host it ran in, so naming
  // it says nothing about the task; a toast question matched a Windows toast
  // installer on these alone.
  'claude', 'code',
]);

// Bigrams nearly every asset or every follow-up carries; matching on them
// says nothing about the task.
const CJK_STOPWORDS = new Set([
  '还有', '没有', '多少', '这个', '那个', '现在', '一下', '可以', '我们', '你的', '什么', '怎么', '是不', '不是',
  '修复', '问题', '实现', '优化', '增加', '处理', '通过', '使用', '进行', '提升', '支持', '导致', '确保',
]);

function stemOf(word) {
  if (word.endsWith('ies') && word.length - 3 >= MIN_STEM_CHARS) return `${word.slice(0, -3)}y`;
  for (const suffix of ['ing', 'ed', 'er']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= MIN_STEM_CHARS) return word.slice(0, -suffix.length);
  }
  if (/(?:s|x|z|ch|sh)es$/.test(word) && word.length - 2 >= MIN_STEM_CHARS) return word.slice(0, -2);
  return word.endsWith('s') && !/(?:ss|us|is)$/.test(word) && word.length - 1 >= MIN_STEM_CHARS ? word.slice(0, -1) : word;
}

// A stopword is cut out of a Han run before bigrams are taken, so two generic
// words side by side (优化实现) do not bridge into a term of their own (化实).
function hanTermsOf(run) {
  let pieces = [run];
  for (const stopword of CJK_STOPWORDS) pieces = pieces.flatMap((piece) => piece.split(stopword));
  return pieces.flatMap((piece) => Array.from({ length: Math.max(0, piece.length - 1) }, (_, index) => piece.slice(index, index + 2)));
}

function termsOf(text) {
  const lower = String(text ?? '').toLowerCase();
  const terms = new Set();
  for (const word of lower.match(/[a-z0-9]+/g) ?? []) {
    if (word.length >= MIN_LATIN_TERM_CHARS && !LATIN_STOPWORDS.has(word)) terms.add(stemOf(word));
  }
  for (const run of lower.match(/\p{Script=Han}+/gu) ?? []) {
    for (const term of hanTermsOf(run)) terms.add(term);
  }
  return terms;
}

function selfDescriptionOf(asset) {
  const signals = Array.isArray(asset?.signals_match) ? asset.signals_match : [];
  return [asset?.short_title, asset?.summary, asset?.nl_summary, ...signals].filter((part) => typeof part === 'string').join(' ');
}

export function sharedTerms(prompt, asset) {
  const assetTerms = termsOf(selfDescriptionOf(asset));
  return [...termsOf(prompt)].filter((term) => assetTerms.has(term));
}

export function relevanceOf(terms) {
  return terms.reduce((score, term) => score + (/\p{Script=Han}/u.test(term) ? HAN_TERM_WEIGHT : 1), 0);
}
