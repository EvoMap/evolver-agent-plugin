// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { isVerificationCommand, verificationFailed } from '../../lib/verification.js';

// FinalStop carries neither the answer nor the turn's tool calls, so a turn is read off the session transcript: one
// JSON record per line, `function_call` / `function_call_result` pairs joined by `callId`, messages with a `role`.

export const EDIT_TOOLS = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const PATH_KEYS = ['file_path', 'notebook_path', 'path'];
const CHECK_COMMAND_MAX_CHARS = 200;
const EXIT_CODE = /^Exit Code: (-?\d+)/m;
const TOOL_ERROR = /^\s*(?:Error\b|<tool_use_error>)/;
const MARK_BYTES = 256;

export function editedPathOf(input) {
  const file = [input?.file_path, input?.notebook_path].find((value) => typeof value === 'string' && value);
  return file ?? null;
}

function recordsOf(text) {
  return text.split('\n').flatMap((line) => {
    try {
      const record = line.trim() ? JSON.parse(line) : null;
      return record && typeof record === 'object' ? [record] : [];
    } catch {
      return [];
    }
  });
}

// A user message the host itself adds inside a turn (a hook's feedback, an error retry) starts no request.
const startsRequest = (record) => record.type === 'message' && record.role === 'user' && record.providerData?.startsNewUserRequest !== false;

function sinceLastPrompt(records) {
  return records.slice(records.findLastIndex(startsRequest) + 1);
}

function fingerprintOf(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return hash.toString(16);
}

/**
 * Where the turn starts in the transcript, taken when its prompt is submitted: the transcript's end, and a
 * fingerprint of the text just before it, so a transcript rewritten since is noticed at the turn's end.
 */
export function turnMarkOf(context) {
  const at = Math.max(0, context.transcriptSize() - MARK_BYTES);
  const before = context.transcriptSince(at);
  return { at, chars: before.length, fingerprint: fingerprintOf(before) };
}

/** The turn's records: those after its mark, or after its last prompt when the transcript was rewritten since. */
export function turnRecordsOf(context) {
  const mark = context.turnStart;
  const text = mark ? context.transcriptSince(mark.at) : '';
  if (mark && fingerprintOf(text.slice(0, mark.chars)) === mark.fingerprint) return recordsOf(text.slice(mark.chars));
  return sinceLastPrompt(recordsOf(context.transcriptSince(0)));
}

/** The records since the latest prompt, for what is known at the turn's end without its mark. */
export const latestTurnOf = (context) => sinceLastPrompt(recordsOf(context.transcriptSince(0)));

function argumentsOf(record) {
  if (record.arguments && typeof record.arguments === 'object') return record.arguments;
  try {
    const parsed = JSON.parse(record.arguments ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function textOf(content) {
  return (Array.isArray(content) ? content : [content]).filter((block) => typeof block?.text === 'string').map((block) => block.text).join('');
}

const shellOutputOf = (text) => {
  const stdout = text.indexOf('\nStdout:');
  return stdout === -1 ? text : text.slice(stdout);
};

function shellFailed(result) {
  if (result.status !== 'completed') return true;
  const exit = EXIT_CODE.exec(result.text);
  if (exit && Number(exit[1]) !== 0) return true;
  return verificationFailed({ text: shellOutputOf(result.text) });
}

const isCheck = (call) => SHELL_TOOLS.has(call.name) && call.args.run_in_background !== true && isVerificationCommand(call.args.command);
const editSucceeded = (result) => result?.status === 'completed' && !TOOL_ERROR.test(result.text);

function callsOf(records) {
  const results = new Map(records
    .filter((record) => record.type === 'function_call_result')
    .map((record) => [record.callId, { status: record.status, text: textOf(record.output) }]));
  return records
    .filter((record) => record.type === 'function_call')
    .map((record) => ({ name: record.name, args: argumentsOf(record), result: results.get(record.callId) }));
}

const lastAnswerMessageOf = (records) => records.findLast((record) => record.type === 'message' && record.role === 'assistant');

export const answerOf = (records) => textOf(lastAnswerMessageOf(records)?.content ?? []).trim();

/** The model to distill on: the one the turn's last answer requested, else the one that served it. */
export function modelOf(records) {
  const providerData = lastAnswerMessageOf(records)?.providerData;
  const model = providerData?.requestModelId || providerData?.model;
  return typeof model === 'string' && model ? { model } : null;
}

/** What a turn did, in the shape of lib/turn/record.js: commands, paths, edited files, checks and its answer. */
export function turnActivityOf(records) {
  const calls = callsOf(records);
  return {
    commands: calls.map((call) => call.args.command).filter((command) => typeof command === 'string'),
    paths: calls.flatMap((call) => PATH_KEYS.map((key) => call.args[key]).filter((value) => typeof value === 'string')),
    edits: calls.filter((call) => EDIT_TOOLS.includes(call.name) && editSucceeded(call.result)).map((call) => editedPathOf(call.args)).filter(Boolean),
    checks: calls
      .filter((call) => isCheck(call) && call.result)
      .map((call) => ({ command: call.args.command.slice(0, CHECK_COMMAND_MAX_CHARS), failed: shellFailed(call.result) })),
    answer: answerOf(records),
  };
}
