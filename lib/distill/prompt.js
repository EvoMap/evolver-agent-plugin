// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { checkExitOf, verdictOf } from '../checks.js';
import { withoutSecrets } from '../redact.js';
import { checkSourceOf } from '../reuse.js';
import { TRIGGERS } from './candidate.js';
import { DIFF_OMITTED, diffFieldsOf } from './project-diff.js';

const LIST_FIELDS = ['strategy', 'validation', 'signals', 'preconditions'];
const ARGUMENT_FIELDS = ['title', 'summary', ...LIST_FIELDS];
const ITEM_NUMBER = /^\s*(?:\d+[.)]|[-*•])\s+/;

export function distillPrompt(candidate, focus = '') {
  const lines = (items, render) => items.map(render).join('\n') || '(none)';
  const focusText = withoutSecrets(String(focus ?? ''));
  return [
    'Below is the record of a task an agent has just finished and verified. Turn it into one reusable Gene:',
    'a method another agent could follow on a similar task, written for the kind of data or system involved,',
    'not for these files, names or values. Do not include the answer itself.',
    ...(focusText ? [`Focus on: ${focusText}`] : []),
    'Keep only knowledge dense enough to reuse. If the record shows routine steps, a lookup or small talk,',
    'with no method another agent would gain from, answer {"skip": "<why, in one sentence>"} instead.',
    'Otherwise answer with a JSON object only, with these fields:',
    '  title: short capability name',
    '  summary: what was solved and under which conditions',
    '  strategy: ordered, reproducible steps',
    '  validation: checks that proved the result',
    '  signals: keywords of the problem this generalizes to',
    '  preconditions: when the method applies',
    '',
    '## Task',
    candidate.prompt,
    '',
    '## Commands run',
    lines(candidate.commands, (command) => `- ${command}`),
    '',
    '## Files read or written',
    lines(candidate.paths, (file) => `- ${file}`),
    '',
    '## Checks',
    lines(candidate.checks, (check) => `- ${verdictOf(check) === 'failed' ? 'FAILED' : verdictOf(check)}: ${check.command}`),
    '',
    '## Final answer',
    candidate.answer,
  ].join('\n');
}

// Models sometimes write a list field as one numbered paragraph ("1. … 2. …"), which the core reads as one step.
function listOf(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  return value.split(/\n+|(?<=\.)\s+(?=\d+[.)]\s)/).map((item) => item.replace(ITEM_NUMBER, '').trim()).filter(Boolean);
}

function jsonObjectOf(text) {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/** Why the model judged the turn not worth a Gene, or null when it wrote one. */
export function declineOf(text) {
  const skip = jsonObjectOf(text)?.skip;
  return typeof skip === 'string' && skip.trim() ? skip.trim() : null;
}

export function argumentsOf(text) {
  const parsed = jsonObjectOf(text);
  if (typeof parsed?.summary !== 'string' || !parsed.summary.trim()) return null;
  for (const field of LIST_FIELDS) if (field in parsed) parsed[field] = listOf(parsed[field]);
  return Object.fromEntries(ARGUMENT_FIELDS.filter((field) => parsed[field] !== undefined).map((field) => [field, parsed[field]]));
}

// The Proxy refuses a request body over 256 KiB; a diff that would push the body past it is left out.
const PROXY_BODY_MAX_BYTES = 256 * 1024;

const bytesOf = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

// A check whose result is unknown proves nothing and is left out. A candidate written before checks kept their exit
// code and source holds only the verdict, and nothing says who saw it.
const traceOf = (candidate) => candidate.checks
  .map((check) => ({ command: check.command, exit: checkExitOf(check), source: checkSourceOf(candidate.source) }))
  .filter(({ exit }) => exit !== null);

function withinBodyLimit(body) {
  if (body.project?.diff === undefined || bytesOf(body) <= PROXY_BODY_MAX_BYTES) return body;
  const { diff, ...project } = body.project;
  return { ...body, project: { ...project, diff_omitted: DIFF_OMITTED.TOO_LARGE } };
}

export function distillBody({ platform, sessionId, candidate, args, usage, trigger = TRIGGERS.SESSION_END }) {
  const { diff, ...project } = candidate.project ?? {};
  return withinBodyLimit({
    platform,
    trigger,
    session_id: sessionId,
    user_prompt: candidate.prompt,
    // The core rejects a Gene that repeats this answer's values (answer_leak).
    final_answer: candidate.answer,
    ...args,
    execution: { trace: traceOf(candidate) },
    // A candidate can hold a snapshot written before the current secret filter.
    ...(candidate.project && { project: { ...project, ...(typeof diff === 'string' && diffFieldsOf(diff)) } }),
    persist: true,
    publish: false,
    ...(usage ? { distill_usage: usage } : {}),
  });
}
