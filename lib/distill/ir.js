// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { MAX_IRS, SIGNAL_MAX_CHARS } from './ir-prompt.js';
import { KINDS } from './kinds.js';

// The model's answer read as 0 to MAX_IRS session Gene IRs, or a skip. The shape is checked lightly here, so a reply
// that could never be accepted is not sent; whether an IR is good enough is the Proxy's call.

const REF = /^R(\d+)(?:-R(\d+))?$/;
const CONTRACT_KINDS = ['command', 'api', 'config'];
const PORTABILITY = ['portable', 'project_bound'];

function parsedJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function jsonValueOf(reply) {
  const text = String(reply ?? '').trim();
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(text)?.[1];
  for (const candidate of [fenced, text]) {
    if (candidate === undefined) continue;
    const whole = parsedJson(candidate.trim());
    if (whole !== undefined) return whole;
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    const inner = start >= 0 && end > start ? parsedJson(candidate.slice(start, end + 1)) : undefined;
    if (inner !== undefined) return inner;
  }
  return undefined;
}

/**
 * The reply as `{ skip }`, or `{ irs }` (fenced JSON, an array or a single object are all read; only the first
 * MAX_IRS count); null when it holds neither.
 */
export function irReplyOf(reply) {
  const value = jsonValueOf(reply);
  if (typeof value?.skip === 'string' && value.skip.trim()) return { skip: value.skip.trim() };
  const items = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : null;
  if (!items) return null;
  return { irs: items.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).slice(0, MAX_IRS) };
}

const isText = (value, max = Infinity, min = 1) => typeof value === 'string' && value.trim().length >= min && value.length <= max;
const isTextList = (value, { min, max, chars }) => Array.isArray(value) && value.length >= min && value.length <= max && value.every((item) => isText(item, chars));

function refsProblemOf(refs, lineCount, { required }) {
  if (!Array.isArray(refs) || (required && refs.length === 0)) return 'refs';
  for (const ref of refs) {
    const match = REF.exec(String(ref));
    const [start, end] = match ? [Number(match[1]), Number(match[2] ?? match[1])] : [0, 0];
    if (!match || start < 1 || end < start || end > lineCount) return 'refs';
  }
  return null;
}

// A step and a contract stand on the lines they cite; a repair's references are the Proxy's to require.
function itemsProblemOf(items, { field, max, check, lineCount, min = 0, refsRequired = true }) {
  if (!Array.isArray(items) || items.length < min || items.length > max) return field;
  for (const [index, item] of items.entries()) {
    const problem = !item || typeof item !== 'object' ? 'item' : check(item) ?? refsProblemOf(item.refs, lineCount, { required: refsRequired });
    if (problem) return `${field}[${index}]${problem === 'item' ? '' : `.${problem}`}`;
  }
  return null;
}

const repairProblemOf = (item) => ['signal', 'cause', 'response', 'verification'].find((key) => !isText(item[key])) ?? null;
const contractProblemOf = (item) => (!CONTRACT_KINDS.includes(item.kind) ? 'kind' : !isText(item.exemplar) ? 'exemplar' : null);

function signalsProblemOf(signals) {
  if (!isTextList(signals, { min: 5, max: 12, chars: SIGNAL_MAX_CHARS })) return 'scope.signals';
  return new Set(signals.map((signal) => signal.trim().toLowerCase())).size === signals.length ? null : 'scope.signals';
}

function scopeProblemOf(scope) {
  if (!scope || typeof scope !== 'object') return 'scope';
  if (scope.use_when !== undefined && !isTextList(scope.use_when, { min: 0, max: 6 })) return 'scope.use_when';
  if (!isTextList(scope.do_not_use_when, { min: 1, max: 6 })) return 'scope.do_not_use_when';
  return signalsProblemOf(scope.signals);
}

function portabilityProblemOf(portability) {
  if (!PORTABILITY.includes(portability?.class)) return 'portability.class';
  const bound = portability.bound_identifiers;
  if (portability.class === 'project_bound' && !isTextList(bound, { min: 1, max: Infinity })) return 'portability.bound_identifiers';
  return null;
}

const optionalListProblemOf = (ir, field) => (ir[field] === undefined || isTextList(ir[field], { min: 0, max: 8, chars: 300 }) ? null : field);

/** Where `ir` breaks the session-gene-ir-v1 shape, as a field path under `ir.`, or null; refs must fall in `lineCount`. */
export function irProblemOf(ir, lineCount) {
  const problem = (!isText(ir.title, 80) && 'title')
    || (!isText(ir.capability_summary, 600, 40) && 'capability_summary')
    || (!KINDS.includes(ir.kind) && 'kind')
    || scopeProblemOf(ir.scope)
    || (!isTextList(ir.preconditions, { min: 1, max: 8 }) && 'preconditions')
    || itemsProblemOf(ir.procedure, { field: 'procedure', min: 2, max: 12, lineCount, check: (step) => (isText(step.action, 400) ? null : 'action') })
    || itemsProblemOf(ir.failure_repairs ?? [], { field: 'failure_repairs', max: 6, lineCount, check: repairProblemOf, refsRequired: false })
    || itemsProblemOf(ir.canonical_contracts ?? [], { field: 'canonical_contracts', max: 6, lineCount, check: contractProblemOf })
    || optionalListProblemOf(ir, 'project_notes')
    || optionalListProblemOf(ir, 'unknowns')
    || portabilityProblemOf(ir.portability);
  return problem ? `ir.${problem}` : null;
}
