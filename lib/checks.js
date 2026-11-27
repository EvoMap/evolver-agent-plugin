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

// A failed assertion can name a deprecated status as its expectation, while the endpoint returned a different code.
const HTTP_STATUS_ASSERTION = /\bexpected[ \t]+status(?:[ \t]+code)?[ \t:=]+[1-5]\d{2}\b[ \t,]+(?:but[ \t]+)?(?:got|received)[ \t:=]+(?:status(?:[ \t]+code)?[ \t:=]+)?([1-5]\d{2})\b/gi;

const STALE_SIGNALS = [
  ['http_404_410', /\bHTTP\/[\d.]+\s+(?:404|410)\b|\b(?:404\s+Not\s+Found|410\s+Gone)\b|\bstatus(?:\s+code)?[\s:=]+(?:404|410)\b/i],
  ['unknown_flag', /\b(?:unknown|unrecognized|unsupported)\s+(?:flag|option|subcommand|arguments?)\b|\bno\s+such\s+option\b|\bflag\s+provided\s+but\s+not\s+defined\b|\berror:\s+unknown\s+option\b/i],
  ['missing_export', /\b(?:ERR_PACKAGE_PATH_NOT_EXPORTED|has\s+no\s+exported\s+member|does\s+not\s+provide\s+an\s+export\s+named|ImportError:\s+cannot\s+import\s+name)\b/],
  ['missing_target_path', /\b(?:ENOENT:\s+no\s+such\s+file\s+or\s+directory|can't\s+open\s+file\b[^\n]*\[Errno\s+2\]|cannot\s+find\s+path\b[^\n]*because\s+it\s+does\s+not\s+exist)\b/i],
];

const KNOWN_STALE_SIGNALS = new Set(STALE_SIGNALS.map(([kind]) => kind));

export function staleSignalOf(check) {
  if (verdictOf(check) !== 'failed') return null;
  if (typeof check?.stale_signal === 'string' && KNOWN_STALE_SIGNALS.has(check.stale_signal)) return check.stale_signal;
  const output = typeof check?.output === 'string' ? check.output : '';
  if (!output) return null;
  return STALE_SIGNALS.find(([kind, pattern]) => {
    const observed = kind === 'http_404_410' ? output.replace(HTTP_STATUS_ASSERTION, 'status $1') : output;
    return pattern.test(observed);
  })?.[0] ?? null;
}

