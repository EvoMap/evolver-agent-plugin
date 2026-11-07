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

// A target names what a run checks: a path, a pytest node id or a test file. Selecting flags narrow a run by name.
const TARGET = /[/:]|\.(?:py|[cm]?[jt]sx?|rs|go|rb|java|kt|php)$/;
const SELECTING_FLAG = /^(?:-k|-m|-t|--grep|--testNamePattern|--filter|--run|-run|--test)(?:=|$)/;

// `python -m pytest` is pytest run as a module; its `-m` is no marker filter.
const PYTHON_MODULE_RUN = /^(?:\S*\/)?python[\d.]*\s+-m\s+/;

function runShapeOf(identity) {
  const tokens = identity.replace(PYTHON_MODULE_RUN, '').split(' ').filter(Boolean);
  const targets = tokens.filter((token) => !token.startsWith('-') && TARGET.test(token));
  const base = tokens.filter((token) => !token.startsWith('-') && !TARGET.test(token));
  return { base: base.join(' '), targets, selects: tokens.some((token) => SELECTING_FLAG.test(token)) };
}

const isWithin = (target, broader) => target === broader || target.startsWith(`${broader}::`) || target.startsWith(`${broader.replace(/\/$/, '')}/`);

/**
 * Whether a passing run of `passing` also ran what `failing` checked: the same runner, and targets that are the same or
 * broader (a whole file over one of its tests, the whole suite over a file), with no name filter of its own.
 */
export function coversCheck(passing, failing) {
  const pass = runShapeOf(checkIdentityOf(passing));
  const fail = runShapeOf(checkIdentityOf(failing));
  if (checkIdentityOf(passing) === checkIdentityOf(failing)) return true;
  if (pass.base !== fail.base || pass.selects) return false;
  if (pass.targets.length === 0) return true;
  return fail.targets.length > 0 && fail.targets.every((target) => pass.targets.some((broader) => isWithin(target, broader)));
}

export function verdictOf(check) {
  if (check?.failed === true) return 'failed';
  if (check?.failed === false) return 'passed';
  return 'unknown';
}

export const hasUnknownChecks = (record) => record?.checks?.some((check) => verdictOf(check) === 'unknown') ?? false;

/**
 * How a check ended, as a distill trace row says it: the host's own `exit` code, else `ok`, whether its output said it
 * passed, which no exit code is made up for; null when neither is known.
 */
export function checkOutcomeOf(check) {
  if (Number.isInteger(check?.exit)) return { exit: check.exit };
  const verdict = verdictOf(check);
  return verdict === 'unknown' ? null : { ok: verdict === 'passed' };
}

function failedEarlierThenPassed(checks, last) {
  return checks.slice(0, -1).some((check) => verdictOf(check) === 'failed' && coversCheck(last.command, check.command));
}

export function checkEvidenceOf(checks) {
  const last = checks?.at(-1);
  const verdict = verdictOf(last);
  if (verdict === 'unknown') return undefined;
  const passed = verdict === 'passed';
  return { kind: checkKindOf(last.command), passed, fail_then_pass: passed && failedEarlierThenPassed(checks, last) };
}
