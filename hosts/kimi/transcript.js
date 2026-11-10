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

// The newest turns' tasks are the ones a turn still waiting for its end can name; older ones are past their end.
const MAX_TASKS = 64;

/** Only discovers fixed task IDs; the reader chooses a bounded file under the known session root. */
export function taskIdsOf(records = []) {
  const ids = [];
  for (const record of records.filter(main)) {
    const event = record.type === 'context.append_loop_event' ? record.event : null;
    if (event?.type === 'tool.call' && event.name === 'TaskOutput') ids.push(taskId(event.args?.task_id));
    if (event?.type === 'tool.result') {
      ids.push(taskId(/^task_id:\s*([A-Za-z0-9_-]+)(?:\r?\n|$)/.exec(text(event.result?.output))?.[1]));
    }
  }
  const newestLast = [...new Set(ids.filter(Boolean).reverse())].reverse();
  return newestLast.slice(-MAX_TASKS);
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

const STATUSES = { completed: 'completed', failed: 'failed', cancelled: 'aborted', interrupted: 'aborted' };

function routeOf(turn) {
  const requests = turn.filter(main).filter((item) => item.type === 'llm.request');
  const routes = new Set(requests.map((item) => JSON.stringify([item.modelAlias, item.model, item.provider, item.thinkingEffort])));
  const request = requests.at(-1);
  if (routes.size !== 1 || !text(request?.modelAlias)) return null;
  return {
    alias: request.modelAlias, model: text(request.model) || null, protocol: text(request.provider) || null,
    effort: text(request.thinkingEffort) || null,
  };
}

/**
 * A turn's status row from the main agent's supported wire: `accepted` while it runs, its terminal status once it
 * ended, `pending` while a background check it started still runs, and its record, answer and model route from the log
 * alone (hook tool output is truncated). Null for no unique user turn of that id, contradictory records, or a turn
 * that runs through the part of a long log left unread. Native turn zero is a real identity.
 */
export function turnStatusOf(records = [], { turnId: wanted, tasks = [], projectDir, unread = null } = {}) {
  const turnId = nativeTurnIdOf(wanted);
  if (turnId === null || records.find((record) => record.type === 'metadata')?.protocol_version !== '1.5') return null;
  const prompts = records.filter(promptOf).filter((record) => nativeTurnIdOf(record.turnId) === turnId);
  if (new Set(prompts.map((record) => record.promptId)).size !== 1) return null;
  const start = records.indexOf(prompts[0]);
  const next = records.findIndex((record, index) => index > start && promptOf(record) && nativeTurnIdOf(record.turnId) !== turnId);
  const crossesUnread = unread && prompts[0].$offset < unread[1] && (next === -1 || records[next].$offset > unread[0]);
  if (crossesUnread) return null;
  const turn = records.slice(start, next === -1 ? undefined : next);
  const isTerminal = (item) => item.type === 'turn.ended' && main(item) && nativeTurnIdOf(item.turnId) === turnId;
  const ended = records.slice(start).filter(isTerminal);
  if (new Set(ended.map((item) => item.reason)).size > 1 || conflictingIdentity(turn)
      || ended.some((item) => item.reason === 'completed' && item.error)) return null;
  const notes = notesOf(turn, tasks, turnId, projectDir);
  const record = turnRecordOf(notes.map(
    (note) => note.running ? { ...note, running: false, exit: null, output: '', failed: null } : note,
  ));
  record.answer = answerOf(turn, turnId);
  const terminal = STATUSES[ended[0]?.reason];
  const checking = notes.some((note) => note.running && isVerificationCommand(note.command));
  const status = !terminal ? 'accepted' : terminal === 'completed' && checking ? 'pending' : terminal;
  return { status, record, answer: record.answer, model: routeOf(turn) };
}
