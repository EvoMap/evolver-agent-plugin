// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { createPluginChannel } from '../../../lib/channels/plugin/adapter.js';
import { isIrPrompt } from '../../../lib/distill/ir-prompt.js';
import { withoutSecrets } from '../../../lib/redact.js';
import { isVerificationCommand } from '../../../lib/verification.js';
import profile from '../profile.js';

const EVENTS = new Set([
  'user.message', 'assistant.turn_start', 'assistant.message', 'assistant.turn_end',
  'tool.execution_start', 'tool.execution_complete', 'abort', 'session.idle', 'session.shutdown',
]);
const SHELLS = new Set(['powershell', 'bash', 'shell']);
const MAX_CALLS = 256;
const MAX_EVENT_IDS = 4096;
const id = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;

function rootMessage(turn, data) {
  if (turn.messageId) {
    // A Stop hook can create another user.message with a new interaction and no actual user input.
    turn.step = null;
    return;
  }
  if (data.content !== turn.prompt || !id(data.messageId)) return;
  turn.messageId = data.messageId;
  turn.injected = !turn.strategy || (typeof data.transformedContent === 'string'
    && data.transformedContent.includes(turn.strategy));
}

function toolStarted(turn, event) {
  const { data, parentId } = event;
  const command = data.arguments?.command;
  if (!SHELLS.has(data.toolName)) return;
  const request = turn.step?.requests?.get(data.toolCallId);
  if (!request || parentId !== turn.step.messageEventId || data.turnId !== turn.step.id) {
    if (isVerificationCommand(command)) turn.incomplete = true;
    return;
  }
  if (request.name !== data.toolName || request.command !== command) {
    turn.incomplete = true;
    return;
  }
  if (!id(data.toolCallId) || typeof command !== 'string' || !command.trim() || command.length > 4000
    || turn.calls.has(data.toolCallId) || turn.calls.size >= MAX_CALLS) {
    turn.incomplete = true;
    return;
  }
  turn.calls.set(data.toolCallId, { step: turn.step, command: withoutSecrets(command), verification: isVerificationCommand(command) });
}

function toolCompleted(turn, data) {
  const call = turn.calls.get(data.toolCallId);
  if (!call) return;
  if (call.step.id !== data.turnId || call.step.interactionId !== data.interactionId) return;
  if (call.completed) { turn.incomplete = true; return; }
  call.completed = true;
  const exit = data.shellExecution?.exitCode;
  const telemetry = data.toolTelemetry?.properties;
  if (Number.isSafeInteger(exit) && telemetry?.executionMode === 'sync' && telemetry.detached === 'false') {
    call.exit = exit;
    call.output = withoutSecrets(data.result?.content).slice(-2000);
  }
}

function recordRequests(turn, requests) {
  turn.step.requests = new Map();
  for (const request of requests) {
    const callId = id(request?.toolCallId);
    if (!callId || turn.step.requests.has(callId) || turn.step.requests.size >= MAX_CALLS) {
      turn.incomplete = true;
      continue;
    }
    if (!SHELLS.has(request?.name)) { turn.step.requests.set(callId, { name: null }); continue; }
    const command = request.arguments?.command;
    if (typeof command !== 'string' || !command.trim() || command.length > 4000) {
      turn.incomplete = true;
      continue;
    }
    turn.step.requests.set(callId, { name: request.name, command });
    if (!isVerificationCommand(command)) continue;
    if (turn.expectedChecks.has(callId) || turn.expectedChecks.size >= MAX_CALLS) {
      turn.incomplete = true;
      continue;
    }
    turn.expectedChecks.set(callId, turn.step);
  }
}

function checksCompleted(turn) {
  for (const [callId, step] of turn.expectedChecks) {
    const call = turn.calls.get(callId);
    if (!call?.verification || call.step !== step || call.exit === undefined) return false;
  }
  return true;
}

function noteEvent(turn, event) {
  const data = event.data ?? {};
  switch (event.type) {
    case 'user.message':
      rootMessage(turn, data);
      break;
    case 'assistant.turn_start':
      turn.step = id(data.turnId) && id(data.interactionId) ? { id: data.turnId, interactionId: data.interactionId } : null;
      break;
    case 'assistant.message':
      if (!turn.step || data.turnId !== turn.step.id || data.interactionId !== turn.step.interactionId
        || !turn.messageId || data.originatingMessageId !== turn.messageId) return;
      turn.step.messageEventId = event.id;
      recordRequests(turn, Array.isArray(data.toolRequests) ? data.toolRequests : []);
      turn.step.answer = !data.toolRequests?.length ? withoutSecrets(data.content).trim().slice(0, 10_000) : '';
      break;
    case 'assistant.turn_end':
      if (turn.step?.id === data.turnId) turn.step.ended = true;
      break;
    case 'tool.execution_start':
      toolStarted(turn, event);
      break;
    case 'tool.execution_complete':
      toolCompleted(turn, data);
      break;
    case 'abort':
      turn.aborted = true;
      break;
  }
}

function notesOf(turn) {
  return [...turn.calls].flatMap(([callId, { command, exit, output }]) => {
    const start = { kind: 'shell', callId, command, running: true };
    return exit === undefined ? [start] : [start, { kind: 'shell', callId, command, exit, output }];
  });
}

/** Attach the Evolver channel to one foreground Copilot CLI session. SDK Stop hooks never settle its turns. */
export async function connectCopilot(joinSession, { env = process.env, overrides = {},
  onError = () => console.error('Evolver could not record Copilot session evidence; pending work is unconfirmed. Check plugin storage and retry.') } = {}) {
  const channel = createPluginChannel({ profile, env, overrides: { ...overrides, confirmTurnCompletion: true } });
  const seen = new Set();
  // Hooks registered during join must stay inactive until native events can be observed.
  let native, session, current, promptAt, pendingTerminal, unsubscribe, ending = false, closed = true, tail = Promise.resolve();

  const reportError = (error) => {
    try { onError(error); } catch { /* Diagnostics must not block the session. */ }
  };
  const ordered = (work) => {
    const next = tail.then(work);
    tail = next.catch(reportError);
    return next.catch(() => ({}));
  };
  const raise = (event, payload, onFailure = reportError) => channel.handle(event, payload, { onError: onFailure });
  const flushTerminal = async () => {
    if (!pendingTerminal) return true;
    let failed = false;
    await channel.handle('terminal', pendingTerminal.payload, {
      retrySettlement: pendingTerminal.retrySettlement,
      onError: (error) => {
        failed = true;
        reportError(error);
      },
    });
    if (!failed) pendingTerminal = null;
    return !failed;
  };
  const settle = async ({ aborted = false, complete = false } = {}) => {
    const turn = current;
    if (turn) {
      const answered = complete && turn.injected && !turn.incomplete && turn.step?.ended && turn.step.answer && checksCompleted(turn);
      const reason = aborted || turn.aborted ? 'aborted' : answered ? 'answer' : 'error';
      pendingTerminal = {
        payload: { ...turn.at, reason, ...(reason === 'answer' && { answer: turn.step.answer }), notes: notesOf(turn) },
        retrySettlement: {},
      };
      current = null;
    }
    // Copilot may emit idle only once. Retry before waiting for the next native callback.
    return await flushTerminal() || flushTerminal();
  };
  const endSession = async () => {
    ending = true;
    if (!(await settle())) return;
    if (session) {
      let failed = false;
      await raise('session_end', session, (error) => {
        failed = true;
        reportError(error);
      });
      if (failed) return;
    }
    session = null;
  };
  const transform = async ({ sessionId, workingDirectory, prompt, transformedPrompt, timestamp }) => {
    const occurredAt = timestamp instanceof Date ? timestamp.getTime() : timestamp;
    if (closed || ending || current || !id(sessionId) || (native?.sessionId && native.sessionId !== sessionId)
      || (session && session.sessionId !== sessionId) || typeof workingDirectory !== 'string' || !isAbsolute(workingDirectory)
      || typeof prompt !== 'string' || typeof transformedPrompt !== 'string' || !Number.isFinite(occurredAt) || isIrPrompt(prompt)
      || !(await flushTerminal())) return {};
    const at = { sessionId, cwd: workingDirectory, turnId: randomUUID() };
    if (!session) {
      let failed = false;
      await raise('session_start', at, (error) => {
        failed = true;
        reportError(error);
      });
      if (failed) return {};
    }
    session = at;
    const { strategy } = await raise('prompt', { ...at, prompt });
    promptAt = occurredAt;
    current = { at, prompt, strategy, calls: new Map(), expectedChecks: new Map() };
    return strategy ? { modifiedTransformedPrompt: transformedPrompt + '\n\n' + strategy } : {};
  };
  const eventOf = async (event) => {
    if (closed || !EVENTS.has(event?.type) || !id(event.id)) return;
    // Native terminal events have no turn ID; keep the prompt fence even after its turn has settled.
    if (['session.idle', 'abort', 'session.shutdown'].includes(event.type)) {
      const occurredAt = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
      if (!Number.isFinite(occurredAt) || (Number.isFinite(promptAt) && occurredAt < promptAt)) return;
    }
    if (seen.has(event.id)) {
      if (event.type === 'session.idle') await flushTerminal();
      if (event.type === 'session.shutdown') await endSession();
      return;
    }
    seen.add(event.id);
    if (seen.size > MAX_EVENT_IDS) seen.delete(seen.values().next().value);
    if (event.type === 'session.shutdown') return endSession();
    if (event.type === 'session.idle') {
      const aborted = event.data?.aborted;
      if (aborted !== undefined && typeof aborted !== 'boolean') return settle();
      return settle({ aborted: aborted === true, complete: true });
    }
    if (current) noteEvent(current, event);
  };
  try {
    native = await joinSession({ hooks: {
      onUserPromptTransformed: (input) => ordered(() => transform(input)),
      onSessionEnd: (input, invocation) => ordered(() => {
        const sessionId = native?.sessionId ?? session?.sessionId;
        if (sessionId && [input?.sessionId, invocation?.sessionId].some((value) => value !== undefined && value !== sessionId)) return;
        return endSession();
      }),
    } });
    unsubscribe = native.on((event) => ordered(() => eventOf(event)));
    closed = false;
  } catch (error) {
    closed = true;
    ending = true;
    channel.close();
    throw error;
  }
  return {
    async idle() { await tail; await channel.idle(); },
    async close() {
      if (closed) return;
      ending = true;
      await ordered(endSession);
      if (pendingTerminal || session) throw new Error('Copilot could not persist its final evidence; retry close after storage recovers.');
      if (closed) return;
      closed = true;
      unsubscribe?.();
      channel.close();
    },
  };
}
