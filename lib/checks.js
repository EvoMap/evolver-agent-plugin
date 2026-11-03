// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

const CHECK_KINDS = [
  ['typecheck', /\btsc\b|\btype-?check\b|\bmypy\b|\bcargo\s+check\b|\bgo\s+vet\b/],
  ['lint', /\blint\b|\beslint\b|\bruff\b|\bclippy\b|\bvalidate\b/],
  ['test', /\btest\b|\bjest\b|\bvitest\b|\bmocha\b|\bpytest\b|\brspec\b|\bphpunit\b/],
];

export function checkKindOf(command) {
  return CHECK_KINDS.find(([, pattern]) => pattern.test(command))?.[0] ?? 'build';
}

const OUTPUT_PIPE = /\s*(?<!\|)\|\s*(?:tail|head|grep|tee|cat|less|more|sed|awk|wc|sort|uniq|cut|tr)\b[^|&;]*/g;
const STREAM_REDIRECT = /\s+\d*>&?\s*(?:\d|\S+)/g;

export function checkIdentityOf(command) {
  return String(command).replace(OUTPUT_PIPE, '').replace(STREAM_REDIRECT, '').replace(/\s+/g, ' ').trim();
}

export function verdictOf(check) {
  if (check?.failed === true) return 'failed';
  if (check?.failed === false) return 'passed';
  return 'unknown';
}

export function checkExitOf(check) {
  const verdict = verdictOf(check);
  if (verdict === 'unknown') return null;
  return verdict === 'failed' ? 1 : 0;
}

function failedEarlierThenPassed(checks, last) {
  const identity = checkIdentityOf(last.command);
  return checks.slice(0, -1).some((check) => verdictOf(check) === 'failed' && checkIdentityOf(check.command) === identity);
}

export function checkEvidenceOf(checks) {
  const last = checks?.at(-1);
  const verdict = verdictOf(last);
  if (verdict === 'unknown') return undefined;
  const passed = verdict === 'passed';
  return { kind: checkKindOf(last.command), passed, fail_then_pass: passed && failedEarlierThenPassed(checks, last) };
}
