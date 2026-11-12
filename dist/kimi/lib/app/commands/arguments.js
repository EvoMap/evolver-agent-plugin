// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

/**
 * Quotes group words the way a shell would (`--summary="two words"` stays one argument) and a backslash
 * escapes the character after it, so a quote can be part of a value; nothing else is expanded.
 */
export function argumentsOf(rawInput) {
  const args = [];
  let current = '';
  let quote = null;
  let started = false;
  let escaped = false;
  for (const char of rawInput) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\' && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}
