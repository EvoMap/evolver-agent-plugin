// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withoutSecrets } from '../redact.js';
import { KINDS, kindSupplementOf } from './kinds.js';

export const IR_VERSION = 'session-gene-ir-v1';
export const MAX_IRS = 2;
export const SIGNAL_MAX_CHARS = 64;

const FIELDS = [
  '- title: the capability\'s name, at most 80 characters.',
  '- capability_summary: what was solved and under which conditions, 40 to 600 characters.',
  `- kind: one of ${KINDS.join(', ')}. Keep the default below unless the record plainly shows another kind; choose`,
  '  refactor only when behaviour stayed the same, and then name the evidence it did and the boundary of the change.',
  `- scope.signals: 5 to 12 distinct triggers another agent would meet (error text, symptom, task phrase), each at most ${SIGNAL_MAX_CHARS} characters.`,
  '- scope.use_when: 0 to 6 situations it fits. scope.do_not_use_when: 1 to 6 situations where it must not be used.',
  '- preconditions: 1 to 8 things that must hold before the first step.',
  '- procedure: 2 to 12 steps, each {"action": "<one imperative step, at most 400 characters>", "refs": ["R12", "R14-R18"]}.',
  '  The first step is the first thing to do.',
  '- failure_repairs: 0 to 6 items {"signal", "cause", "response", "verification", "refs"}: an observed failure, its',
  '  confirmed cause, what fixed it and how that was verified.',
  '- canonical_contracts: 0 to 6 items {"kind": "command" | "api" | "config", "applies_when", "exemplar", "refs"}: exact',
  '  syntax worth keeping as it is.',
  '- project_notes: 0 to 8 facts true only of this project (its directories, script names, variables, fields), at most',
  '  300 characters each. They stay on this machine.',
  '- unknowns: 0 to 8 things the record did not confirm, at most 300 characters each.',
  '- portability: {"class": "portable" | "project_bound", "bound_identifiers": [...]}; project_bound lists the',
  '  identifiers it depends on.',
];

const RULES = [
  '1. Every procedure step, failure repair and contract cites the record lines it rests on in refs, as R<n> or',
  '   R<a>-R<b>. Cite only lines that exist.',
  '2. A contract\'s exemplar is copied from a line it cites, character for character: a part of that line\'s text.',
  '3. When a check failed and later passed after edits (an error episode), write at least one failure_repair whose',
  '   refs include that failed check line and whose signal is the failure the check printed.',
  '4. Write roles, not names: "the project\'s test entry point", not a script path; "the config loader", not its file.',
  '   This project\'s directories, file names, variables, functions and fields go into project_notes, not into the',
  '   summary, scope, preconditions, procedure or failure_repairs: no project path there, at most two of its names.',
  '5. Give at least one do_not_use_when.',
  '6. Declare portability: portable when another project could follow it as written; project_bound, with the',
  '   identifiers it needs, when it only makes sense here.',
  '7. Invent nothing: no cause, test or verification the record does not show; put doubts into unknowns. Never',
  '   include secrets, absolute paths or the values of the final answer.',
];

function checkLabelOf(line) {
  const exit = Number.isInteger(line.exit) ? `exit ${line.exit}` : 'no exit code';
  if (line.failed === true) return `check (failed, ${exit})`;
  return Number.isInteger(line.exit) ? `check (${exit})` : 'check (passed, no exit code)';
}

const renderedLine = (line, index) => `R${index + 1} ${line.kind === 'check' ? checkLabelOf(line) : line.kind}: ${line.text}`;

/** The record as the model reads it: one numbered line per record line, R1 first. */
export const numberedRecordOf = (record) => record.map(renderedLine).join('\n');

/**
 * The `session-gene-ir-v1` prompt: the IR's fields and rules, the supplement for the record's default `kind`, and the
 * record. The model answers 0 to MAX_IRS IR objects, one per unrelated task, or a skip.
 */
export function irPromptOf({ record, kind, focus = '' }) {
  const focusText = withoutSecrets(String(focus ?? '')).trim();
  return [
    `Evolver distillation, prompt ${IR_VERSION}. Do not continue the task and do not address the person.`,
    'Below is the record of work an agent did in one session, proved by checks the host saw run. Turn it into reusable',
    'method knowledge: what another agent should do on a similar task in a different project.',
    ...(focusText ? [`Focus on: ${focusText}`] : []),
    `Answer with JSON only: an array of 0 to ${MAX_IRS} objects in the fields below, one per unrelated task (most`,
    'sessions hold one), or {"skip": "<why, in one sentence>"} when the record holds no method another agent would',
    'gain from (routine edits, a lookup, small talk).',
    '',
    `## Fields (${IR_VERSION})`,
    ...FIELDS,
    '',
    '## Rules',
    ...RULES,
    '',
    `## Kind: ${kind} (the default for this record)`,
    ...kindSupplementOf(kind),
    '',
    '## Record',
    numberedRecordOf(record),
  ].join('\n');
}
