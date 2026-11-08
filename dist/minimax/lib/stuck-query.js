// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withoutSecrets } from './redact.js';

const MAX_QUERY_CHARS = 512;
const MAX_ERROR_LINES = 6;
const ERROR_LINE_MAX_CHARS = 160;
const MAX_FAILING_TESTS = 4;
const MAX_FILES = 6;
const MAX_CHANGED_IDENTIFIERS = 12;
const MAX_IDENTIFIERS_PER_EDIT = 20;

const ANSI = /\x1b\[[0-9;]*m/g;
const ERROR_LINE = /(Error|Exception|assert|FAIL|panic:|undefined:|cannot use|expected|E {3})/i;
const FAILING_TEST = /(?:FAIL(?:ED)?:?\s+|--- FAIL: |✕ |● )([\w./:[\]<>-]{4,120})/g;
const ABSOLUTE_PATH = /(?<![\w.])(?:\/[\w.@-]+)+\/([\w.@-]+)/g;
const IDENTIFIER = /\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g;
const KEYWORDS = new Set([
  'null', 'true', 'false', 'None', 'True', 'False', 'self', 'this', 'super', 'return', 'const', 'function', 'async', 'await',
  'import', 'export', 'from', 'class', 'struct', 'func', 'pass', 'elif', 'else', 'while', 'yield', 'void', 'static', 'public',
  'private', 'string', 'number', 'boolean', 'undefined', 'with', 'type', 'interface', 'package', 'defer', 'range', 'lambda',
]);

const LANGUAGES = {
  '.go': 'Go', '.py': 'Python', '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
  '.mjs': 'JavaScript', '.java': 'Java', '.rs': 'Rust', '.rb': 'Ruby', '.cs': 'C#', '.php': 'PHP', '.kt': 'Kotlin', '.swift': 'Swift',
};

const distinct = (items) => [...new Set(items)];

function baseName(path) {
  return String(path).split(/[\\/]/).pop() ?? '';
}

function languageOf(path) {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? LANGUAGES[name.slice(dot)] : undefined;
}

/** The programming languages of the files a turn touched, by extension. */
export function languagesOf(paths) {
  return distinct((paths ?? []).map(languageOf).filter(Boolean)).sort();
}

/** Identifiers an edit's new text has and its old text lacked, language keywords left out. */
export function identifiersAddedBy(before, after) {
  const known = new Set(String(before ?? '').match(IDENTIFIER) ?? []);
  const added = (String(after ?? '').match(IDENTIFIER) ?? []).filter((word) => !known.has(word) && !KEYWORDS.has(word));
  return distinct(added).slice(0, MAX_IDENTIFIERS_PER_EDIT);
}

function mostFrequent(words, limit) {
  const counts = new Map();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts].sort((left, right) => right[1] - left[1]).slice(0, limit).map(([word]) => word);
}

function errorLinesOf(output) {
  const lines = output.split('\n').map((line) => line.replace(ABSOLUTE_PATH, '$1').trim());
  return distinct(lines.filter((line) => line.length > 8 && ERROR_LINE.test(line)).map((line) => line.slice(0, ERROR_LINE_MAX_CHARS))).slice(0, MAX_ERROR_LINES);
}

function failingTestsOf(output) {
  return distinct([...output.matchAll(FAILING_TEST)].map((match) => match[1])).slice(0, MAX_FAILING_TESTS);
}

/**
 * What the agent is stuck on, from what a failed check printed and what the turn touched: the identifiers its edits
 * introduced, the error lines, the failing tests and the files' base names; '' when the output names no error. Paths
 * are cut to base names and secrets redacted, since the query leaves the machine.
 * @param {{ output: string, paths?: string[], identifiers?: string[] }} input
 */
export function stuckQueryOf({ output, paths = [], identifiers = [] }) {
  const text = withoutSecrets(String(output ?? '').replace(ANSI, ''));
  const errors = errorLinesOf(text);
  if (errors.length === 0) return '';
  const files = distinct(paths.map(baseName).filter(Boolean)).slice(-MAX_FILES);
  const changed = mostFrequent(identifiers, MAX_CHANGED_IDENTIFIERS);
  const tests = failingTestsOf(text);
  return [
    changed.length > 0 ? `changed: ${changed.join(', ')}` : '',
    errors.join('; '),
    tests.length > 0 ? `failing: ${tests.join(', ')}` : '',
    files.length > 0 ? `files: ${files.join(', ')}` : '',
  ].filter(Boolean).join(' | ').slice(0, MAX_QUERY_CHARS);
}
