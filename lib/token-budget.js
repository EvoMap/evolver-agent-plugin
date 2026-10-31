// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// A character count says little about what a text costs the model: a Han character is about one token, Latin text
// about four characters to one. Counting characters let 6000 of them hold some 1500 tokens of English but 6000 of
// Chinese, so every injection budget is in estimated tokens.
const WIDE_SCRIPTS = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]';
const WIDE_CHARS = new RegExp(WIDE_SCRIPTS, 'gu');
const WIDE_CHAR = new RegExp(`^${WIDE_SCRIPTS}$`, 'u');
const NARROW_CHARS_PER_TOKEN = 4;
const SAFETY_LINE = /^\s*(?:\d+\.\s*)?safety boundary:/i;

export function tokensOf(text) {
  const wide = text.match(WIDE_CHARS)?.length ?? 0;
  return wide + Math.ceil((text.length - wide) / NARROW_CHARS_PER_TOKEN);
}

/** The longest start of `text` that costs at most `tokens`. */
export function headOf(text, tokens) {
  let cost = 0;
  let end = 0;
  for (const char of text) {
    cost += WIDE_CHAR.test(char) ? 1 : 1 / NARROW_CHARS_PER_TOKEN;
    if (cost > tokens) break;
    end += char.length;
  }
  return text.slice(0, end);
}

const lineCostOf = (line) => tokensOf(line) + 1;

export function linesCostOf(lines) {
  return lines.reduce((sum, line) => sum + lineCostOf(line), 0);
}

// The opening line says what the step is and a safety boundary what it must not do, so both outrank the detail
// between them when a step has to be shortened.
function byPriority(lines) {
  const indexes = lines.map((_, index) => index);
  const rank = (index) => (index === 0 ? 0 : SAFETY_LINE.test(lines[index]) ? 1 : 2);
  return indexes.sort((left, right) => rank(left) - rank(right) || left - right);
}

/**
 * The lines that fit `tokens`, in their own order: the first line and safety boundaries before the rest; none when
 * the first line does not fit, since the others say nothing without it.
 */
export function linesWithin(lines, tokens) {
  const kept = new Set();
  let left = tokens;
  for (const index of byPriority(lines)) {
    const cost = lineCostOf(lines[index]);
    if (index === 0 && cost > left) return [];
    if (cost > left) continue;
    kept.add(index);
    left -= cost;
  }
  return lines.filter((_, index) => kept.has(index));
}

/**
 * Splits `tokens` among items of `costs`: an item that needs less than an even share gets what it needs, and what
 * it leaves goes to the rest.
 */
export function sharesOf(costs, tokens) {
  const shares = new Array(costs.length).fill(0);
  const cheapestFirst = costs.map((_, index) => index).sort((left, right) => costs[left] - costs[right]);
  let left = tokens;
  cheapestFirst.forEach((index, order) => {
    shares[index] = Math.min(costs[index], Math.floor(left / (cheapestFirst.length - order)));
    left -= shares[index];
  });
  return shares;
}
