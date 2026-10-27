// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withoutSecrets } from '../redact.js';

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
    lines(candidate.checks, (check) => `- ${check.failed ? 'FAILED' : 'passed'}: ${check.command}`),
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

export function distillBody({ platform, sessionId, candidate, args, usage }) {
  return {
    platform,
    trigger: 'session_end',
    session_id: sessionId,
    user_prompt: candidate.prompt,
    // The core rejects a Gene that repeats this answer's values (answer_leak).
    final_answer: candidate.answer,
    ...args,
    execution: { trace: candidate.checks.map((check) => ({ command: check.command, exit: check.failed ? 1 : 0 })) },
    persist: true,
    publish: false,
    ...(usage ? { distill_usage: usage } : {}),
  };
}
