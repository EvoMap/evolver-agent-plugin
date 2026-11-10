// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { resolve, isAbsolute } from 'node:path';

import { turnRecordOf } from '../../lib/turn/record.js';
import { isVerificationCommand } from '../../lib/verification.js';

const text = (value) => typeof value === 'string' ? value : '';
export const nativeTurnIdOf = (value) => Number.isSafeInteger(value) && value >= 0
  ? String(value)
  : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? value : null;
const main = (record) => record.agentId === 'main';
const promptOf = (record) => record.type === 'turn.prompt' && main(record) && record.origin?.kind === 'user'
  && nativeTurnIdOf(record.turnId) !== null && text(record.promptId);
const editTools = new Set(['Write', 'Edit']);
const taskId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
const validResult = (result) => result && typeof result === 'object' && typeof result.output === 'string'
  && Number.isFinite(result.durationMs) && result.durationMs >= 0
  && (result.isError === undefined || typeof result.isError === 'boolean');
const pathOf = (input, cwd) => text(input?.path)
  && (isAbsolute(input.path) ? input.path : text(cwd) && isAbsolute(cwd) ? resolve(cwd, input.path) : null);

/** Only discovers fixed task IDs; caller chooses a bounded file under the known session root. */
export function taskIdsOf(records = [], payload = {}) {
  const ids = [taskId(payload.task_id)];
  for (const record of records.filter(main)) {
    const event = record.type === 'context.append_loop_event' ? record.event : null;
    if (event?.type === 'tool.call' && event.name === 'TaskOutput') ids.push(taskId(event.args?.task_id));
    if (event?.type === 'tool.result') {
      ids.push(taskId(/^task_id:\s*([A-Za-z0-9_-]+)(?:\r?\n|$)/.exec(text(event.result?.output))?.[1]));
    }
  }
  return [...new Set(ids.filter(Boolean))];
}

function callsOf(records, turnId) {
  const calls = new Map();
  for (const record of records.filter(main)) {
    const call = record.type === 'context.append_loop_event' ? record.event : null;
    if (call?.type !== 'tool.call' || nativeTurnIdOf(call.turnId) !== turnId
        || !text(call.uuid) || !text(call.toolCallId)) continue;
    if (!calls.has(call.uuid)) calls.set(call.uuid, call);
  }
  return [...calls.values()];
}

function resultOf(records, call) {
  const results = records.filter(main)
    .filter((record) => record.type === 'context.append_loop_event' && record.event?.type === 'tool.result'
      && record.event.parentUuid === call.uuid && record.event.toolCallId === call.toolCallId)
    .map((record) => record.event.result);
  const distinct = new Map(results.map((result) => [JSON.stringify(result), result]));
  return distinct.size === 1 && validResult([...distinct.values()][0]) ? [...distinct.values()][0] : null;
}

function notesOf(records, tasks, turnId, cwd) {
  return callsOf(records, turnId).flatMap((call) => {
    const result = resultOf(records, call);
    const input = call.args && typeof call.args === 'object' ? call.args : {};
    if (call.name === 'Bash' && text(input.command)) {
      const expectedTask = taskId(/^task_id:\s*([A-Za-z0-9_-]+)(?:\r?\n|$)/.exec(text(result?.output))?.[1]);
      const matching = tasks.filter((task) => expectedTask && task?.kind === 'process'
        && task.parentToolCallId === call.toolCallId && task.command === input.command && task.taskId === expectedTask);
      const task = matching.length === 1 ? matching[0] : null;
      if (task) {
        const terminal = ['completed', 'failed'].includes(task.status);
        const exit = terminal && Number.isInteger(task.exitCode) ? task.exitCode : null;
        return [{
          kind: 'shell', command: input.command, exit, output: '',
          ...(task.status === 'failed' && { failed: true }),
          ...(!terminal && { running: true }),
          callId: call.toolCallId,
        }];
      }
      // Recognising a background wrapper can only downgrade evidence; its text can never prove success.
      const pending = !result || input.run_in_background === true || /^task_id:/m.test(text(result?.output));
      return [{
        kind: 'shell', command: input.command, exit: null, output: result?.output ?? '',
        ...(!pending && result?.isError === true && { failed: true }),
        ...(pending && { running: true }),
        callId: call.toolCallId,
      }];
    }
    const file = pathOf(input, call.display?.cwd || cwd);
    return editTools.has(call.name) && file && result && result.isError !== true
      ? [{ kind: 'edit', paths: [file], callId: call.toolCallId }]
      : [];
  });
}

function answerOf(records, turnId) {
  const step = records.filter(main).findLast((record) => record.type === 'context.append_loop_event'
    && record.event?.type === 'step.end' && nativeTurnIdOf(record.event.turnId) === turnId)?.event;
  if (!step || step.finishReason !== 'end_turn' || step.providerFinishReason !== 'completed') return '';
  const parts = new Map();
  for (const record of records.filter(main)) {
    const part = record.type === 'context.append_loop_event' ? record.event : null;
    if (part?.type === 'content.part' && nativeTurnIdOf(part.turnId) === turnId && part.stepUuid === step.uuid
        && part.part?.type === 'text' && text(part.uuid) && !parts.has(part.uuid)) {
      parts.set(part.uuid, text(part.part.text));
    }
  }
  return [...parts.values()].join('').trim();
}

function conflictingIdentity(records) {
  const seen = new Map();
  for (const record of records.filter(main)) {
    const event = record.type === 'context.append_loop_event' ? record.event : null;
    if (event?.type !== 'tool.call') continue;
    for (const key of [`uuid:${event.uuid}`, `call:${event.toolCallId}`]) {
      const value = JSON.stringify(event);
      if (seen.has(key) && seen.get(key) !== value) return true;
      seen.set(key, value);
    }
  }
  return false;
}

function admissionOf(prompt, payload) {
  if (payload.hook_event_name !== 'TurnStarted' || payload.origin_kind !== 'user'
      || nativeTurnIdOf(payload.turn_id) !== nativeTurnIdOf(prompt.turnId)
      || (payload.prompt_id !== undefined && payload.prompt_id !== prompt.promptId)
      || !Number.isSafeInteger(prompt.time) || !Array.isArray(prompt.input)) return null;
  const parts = prompt.input
    .filter((part) => part?.type === 'text' && part.meta?.source !== 'user prompt submit hook')
    .map((part) => text(part.text));
  if (!parts.length || !text(payload.prompt).trim() || parts.join('').trim() !== text(payload.prompt).trim()) {
    return null;
  }
  return { prompt: parts.join('\n').trim(), time: prompt.time };
}

/** Decode only the main agent's supported native wire; native turn zero is a real identity. */
export function decodeNativeFacts(records = [], tasks = [], payload = {}, context = {}) {
  const schema = records.find((record) => record.type === 'metadata')?.protocol_version ?? context.schemaVersion;
  const schemaSupported = schema === '1.5';
  const binding = records.findLast((record) => record.type === 'profile.bind' && main(record));
  const modelHint = binding && text(binding.modelAlias)
    ? { alias: binding.modelAlias, effort: text(binding.thinkingEffort) || null }
    : context.modelHint ?? null;
  const empty = {
    status: schemaSupported ? 'ok' : 'unsupported',
    schemaSupported,
    schemaVersion: schemaSupported ? schema : null,
    bind: null, terminal: null, modelHint, record: null, notes: [], toolTurnId: null,
  };
  if (!schemaSupported) return empty;
  const boundTurn = nativeTurnIdOf(context.turnId);
  const wanted = boundTurn ?? nativeTurnIdOf(payload.turn_id);
  const prompts = records.filter(promptOf).filter((record) => wanted !== null
    ? nativeTurnIdOf(record.turnId) === wanted
    : context.after ? record.$offset >= context.after.offset : true);
  const unique = new Map(prompts.map((record) => [`${nativeTurnIdOf(record.turnId)}:${record.promptId}`, record]));
  if (unique.size !== 1 || (payload.hook_event_name === 'UserPromptSubmit' && wanted === null && !context.after)) {
    return empty;
  }
  const prompt = [...unique.values()][0];
  const turnId = nativeTurnIdOf(prompt.turnId);
  const start = records.indexOf(prompt);
  const turnBinding = records.slice(0, start + 1).findLast((record) => record.type === 'profile.bind' && main(record));
  const boundModelHint = turnBinding && text(turnBinding.modelAlias)
    ? { alias: turnBinding.modelAlias, effort: text(turnBinding.thinkingEffort) || null }
    : context.modelHint ?? null;
  const next = records.findIndex(
    (record, index) => index > start && promptOf(record) && nativeTurnIdOf(record.turnId) !== turnId,
  );
  const turn = records.slice(start, next === -1 ? undefined : next);
  const isTerminal = (item) => item.type === 'turn.ended' && main(item) && nativeTurnIdOf(item.turnId) === turnId;
  let ended = turn.findLast(isTerminal);
  // A bound turn can finish late. Keep the untagged model requests within its original prompt boundary.
  if (boundTurn !== null && next !== -1) {
    for (const item of records.slice(next)) {
      if (!isTerminal(item)) continue;
      if ((ended && ended.reason !== item.reason) || (item.reason === 'completed' && item.error)) {
        return { ...empty, status: 'partial' };
      }
      ended ??= item;
    }
  }
  if (conflictingIdentity(turn) || (ended?.reason === 'completed' && ended.error)) {
    return { ...empty, status: 'partial' };
  }
  const notes = notesOf(turn, tasks, turnId, payload.cwd ?? context.projectDir);
  const pendingVerification = notes.some((note) => note.running && isVerificationCommand(note.command));
  // The indexed wire gives one note per call, so it can retain the order of unfinished checks locally.
  const record = turnRecordOf(notes.map(
    (note) => note.running ? { ...note, running: false, exit: null, output: '', failed: null } : note,
  ));
  record.answer = answerOf(turn, turnId);
  const requests = turn.filter(main).filter((item) => item.type === 'llm.request');
  const request = requests.at(-1);
  const routes = new Set(
    requests.map((item) => JSON.stringify([item.modelAlias, item.model, item.provider, item.thinkingEffort])),
  );
  const terminalHint = routes.size === 1 && request && text(request.modelAlias)
    ? {
      alias: request.modelAlias,
      effort: text(request.thinkingEffort) || null,
      model: text(request.model) || null,
      protocol: text(request.provider) || null,
    }
    : null;
  const terminal = ended && ['completed', 'failed', 'cancelled', 'interrupted'].includes(ended.reason)
    ? { turnId, reason: ended.reason, answer: record.answer, modelHint: terminalHint }
    : null;
  const hookCalls = records.filter(main).filter((item) => item.type === 'context.append_loop_event'
    && item.event?.type === 'tool.call' && item.event.toolCallId === payload.tool_call_id);
  const hookTurns = [...new Set(hookCalls.map((item) => nativeTurnIdOf(item.event.turnId)).filter((id) => id !== null))];
  const toolTurnId = hookTurns.length === 1
    ? hookTurns[0]
    : payload.hook_event_name === 'PreToolUse' && nativeTurnIdOf(context.turnId) !== null ? turnId : null;
  const admission = prompts.length === 1 && next === -1 ? admissionOf(prompt, payload) : null;
  return {
    ...empty,
    modelHint: boundModelHint,
    bind: { turnId, promptId: prompt.promptId, origin: 'user', mark: prompt.$offset ?? null },
    ...(admission && { admission }), terminal, record, notes, pendingVerification, toolTurnId,
  };

}
