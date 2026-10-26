// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// Antigravity hands hooks no prompt and no answer, only the conversation's transcript: one JSON step per line
// (`step_index`, `source`, `type`, `status`, `created_at`, `content`, `tool_calls`, and on a failed tool's result
// `error`), appended as each step completes, so not in step order. A compaction rewrites the file, so a turn is
// marked by its prompt's `step_index` and `created_at`, never by where its line was.

const USER_REQUEST = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/;
const INTERMEDIATE_PLANNER = /^my_tool_call_analysis:/;

function parsedStep(line) {
  try {
    const step = JSON.parse(line);
    return step && typeof step === 'object' && typeof step.type === 'string' ? step : null;
  } catch {
    return null;
  }
}

/** The transcript's steps in file order; a line cut off or not JSON is no step. */
export const stepsOf = (text) => String(text ?? '').split('\n').map(parsedStep).filter(Boolean);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => typeof block?.text === 'string').map((block) => block.text).join('\n');
}

export function promptOf(content) {
  const text = textOf(content);
  const request = USER_REQUEST.exec(text);
  return (request ? request[1] : text).trim();
}

const isUserPrompt = (step) => step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT';

const markOf = (step) => ({ stepIndex: step.step_index ?? null, createdAt: step.created_at ?? null });

function isMarked(step, mark) {
  const { stepIndex, createdAt } = markOf(step);
  return isUserPrompt(step) && stepIndex === mark.stepIndex && createdAt === mark.createdAt;
}

function isLaterThan(step, mark) {
  const at = Date.parse(step.created_at);
  const markedAt = Date.parse(mark.createdAt);
  if (Number.isFinite(at) && Number.isFinite(markedAt)) return at > markedAt;
  return Number.isInteger(step.step_index) && Number.isInteger(mark.stepIndex) && step.step_index > mark.stepIndex;
}

/**
 * The person's latest prompt, `{ prompt, mark, turnId, steps }` with the steps written after it, or null when
 * the transcript holds none. A subagent's task is no prompt of the person's.
 */
export function latestTurnOf(steps) {
  const at = steps.findLastIndex(isUserPrompt);
  if (at < 0) return null;
  const mark = markOf(steps[at]);
  return { prompt: promptOf(steps[at].content), mark, turnId: `${mark.stepIndex}@${mark.createdAt}`, steps: steps.slice(at + 1) };
}

/** The steps of the turn the marked prompt opened: those written after it, or later than it once a compaction dropped it. */
export function stepsAfter(steps, mark) {
  const at = steps.findIndex((step) => isMarked(step, mark));
  return at >= 0 ? steps.slice(at + 1) : steps.filter((step) => isLaterThan(step, mark));
}

// transcript.jsonl writes every argument as a JSON-encoded string; transcript_full.jsonl and older versions do not.
function decodedArgument(value) {
  if (typeof value !== 'string' || !/^["[{]/.test(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function callsOf(step) {
  const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
  return calls
    .filter((call) => typeof call?.name === 'string')
    .map((call) => ({
      name: call.name,
      args: Object.fromEntries(Object.entries(call.args ?? {}).map(([key, value]) => [key, decodedArgument(value)])),
      result: null,
    }));
}

const isToolResult = (step) => step.source === 'MODEL' && step.type !== 'PLANNER_RESPONSE';

function finalAnswerOf(step, calls) {
  const text = textOf(step.content).trim();
  return calls.length === 0 && text && !INTERMEDIATE_PLANNER.test(text) ? text : null;
}

const stepIndexOf = (step) => (Number.isInteger(step.step_index) ? step.step_index : Infinity);

/**
 * What a turn did, from the steps that followed its prompt, read in step order up to the next prompt: each tool
 * call with the result step that answered it (results follow their planner step in call order; a call no result
 * answered keeps `result: null`), and the last planner text that called no tool, which is the answer.
 */
export function turnActivityOf(steps) {
  const calls = [];
  let awaiting = [];
  let answer = '';
  for (const step of [...steps].sort((a, b) => stepIndexOf(a) - stepIndexOf(b))) {
    if (isUserPrompt(step)) break;
    if (step.type === 'PLANNER_RESPONSE') {
      const planned = callsOf(step);
      calls.push(...planned);
      awaiting = planned;
      answer = finalAnswerOf(step, planned) ?? answer;
    } else if (isToolResult(step) && awaiting.length > 0) {
      awaiting.shift().result = step;
    }
  }
  return { calls, answer };
}
