// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { checkOutcomeOf, verdictOf } from '../checks.js';
import { checkSourceOf } from '../reuse.js';
import { modelDiffLinesOf } from './model-diff.js';
import { DIFF_OMITTED, diffFieldsOf } from './project-diff.js';

// A session's work turns as numbered record lines (`R<n>` is line n), the one text the model reads and the Proxy
// checks the model's references against. Everything in a work turn is redacted already.

export const PROXY_BODY_MAX_BYTES = 256 * 1024;
// Kept free for the IR and the request's other fields, so the record is fitted once, before the model reads it.
const RESERVED_BYTES = 32 * 1024;
const TEXT_LINE_MAX_CHARS = 400;
const COMMAND_LINE_MAX_CHARS = 1_000;

const bytesOf = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

const chunksOf = (text) => text.match(new RegExp(`[\\s\\S]{1,${TEXT_LINE_MAX_CHARS}}`, 'g')) ?? [];

function textLines(kind, text) {
  return String(text ?? '').split('\n').map((part) => part.trim()).filter(Boolean).flatMap(chunksOf).map((part) => ({ kind, text: part }));
}

const oneLine = (text) => String(text).replace(/\s*\n\s*/g, ' ↵ ').slice(0, COMMAND_LINE_MAX_CHARS);

function relativePathOf(path, root) {
  const normalized = String(path).replaceAll('\\', '/');
  const prefix = root ? `${String(root).replaceAll('\\', '/').replace(/\/+$/, '')}/` : null;
  return prefix && normalized.startsWith(prefix) ? normalized.slice(prefix.length) : String(path);
}

function checkLinesOf(step) {
  const verdict = verdictOf(step);
  if (verdict === 'unknown') return [{ kind: 'command', text: oneLine(step.command) }];
  const hasExit = Number.isInteger(step.exit);
  const failedWithoutCode = verdict === 'failed' && !(hasExit && step.exit !== 0);
  const check = { kind: 'check', text: oneLine(step.command), ...(hasExit && { exit: step.exit }), ...(failedWithoutCode && { failed: true }) };
  return [check, ...(verdict === 'failed' ? textLines('output', step.output) : [])];
}

function stepLinesOf(step, root) {
  if (step.kind === 'edit') return [{ kind: 'edit', text: relativePathOf(step.path, root) }];
  if (step.kind === 'command') return [{ kind: 'command', text: oneLine(step.command) }];
  return checkLinesOf(step);
}

const isRepeatedEdit = (line, index, lines) => line.kind === 'edit' && lines[index - 1]?.kind === 'edit' && lines[index - 1].text === line.text;

function turnLinesOf(turn, root) {
  const steps = turn.steps.flatMap((step) => stepLinesOf(step, root)).filter((line, index, lines) => !isRepeatedEdit(line, index, lines));
  return [
    { kind: 'turn', text: `Turn ${turn.turn}` },
    ...textLines('prompt', turn.prompt),
    ...steps,
    ...textLines('answer', turn.answer),
    ...textLines('correction', turn.correction),
  ];
}

function diffLinesOf(project) {
  if (typeof project?.diff === 'string') return modelDiffLinesOf(project.diff).map((text) => ({ kind: 'diff', text }));
  return project?.diff_omitted ? [{ kind: 'diff', text: `(diff left out: ${project.diff_omitted})` }] : [];
}

/** Every check of `turns` whose result is known, in order, as `{ command, exit | ok, source }`; none is made up. */
export function traceOf(turns, source) {
  return turns.flatMap((turn) => turn.steps).filter((step) => step.kind === 'check').flatMap((check) => {
    const outcome = checkOutcomeOf(check);
    return outcome ? [{ command: check.command, ...outcome, source: checkSourceOf(source) }] : [];
  });
}

const firstTextOf = (texts) => texts.find((text) => typeof text === 'string' && text.trim()) ?? '';

function fieldsOf(turns, source) {
  return {
    userPrompt: firstTextOf(turns.map((turn) => turn.prompt)),
    finalAnswer: firstTextOf(turns.map((turn) => turn.answer).reverse()),
    trace: traceOf(turns, source),
  };
}

// A snapshot is saved at a turn's end and sent later, perhaps by a version whose secret filter catches more: it is
// checked again by the rules it is sent under.
function recheckedProject(project) {
  if (typeof project?.diff !== 'string') return project ?? null;
  const checked = diffFieldsOf(new TextEncoder().encode(project.diff));
  return checked.diff_omitted ? checked : project;
}

function fitted(range, root) {
  let turns = range.turns;
  let project = recheckedProject(range.project);
  let withDiff = true;
  const diffLines = diffLinesOf(project);
  const recordOf = () => [...turns.flatMap((turn) => turnLinesOf(turn, root)), ...(withDiff ? diffLines : [])];
  const fits = () => bytesOf({ record: recordOf(), project, ...fieldsOf(turns, range.source) }) <= PROXY_BODY_MAX_BYTES - RESERVED_BYTES;
  if (!fits() && typeof project?.diff === 'string') project = { diff_omitted: DIFF_OMITTED.TOO_LARGE };
  if (!fits()) withDiff = false;
  while (!fits() && turns.length > 1) turns = turns.slice(1);
  return { turns, project, record: recordOf() };
}

/**
 * What one distillation of `range` reads and sends: the record lines, the project snapshot (its diff left out as
 * too_large when the body would not fit), the first prompt and last answer, the trace of every check and the project
 * directory. Fitted to the Proxy's body limit before any model reads it, so the lines it cites are the lines sent:
 * the diff first, then the diff lines, then the oldest turns give way.
 */
export function sessionRecordOf(range) {
  const root = range.project?.root ?? range.base?.root ?? null;
  const { turns, project, record } = fitted(range, root);
  const projectDir = root ?? range.projectDir ?? null;
  return { record, project, ...fieldsOf(turns, range.source), ...(projectDir && { projectDir }), turns };
}
