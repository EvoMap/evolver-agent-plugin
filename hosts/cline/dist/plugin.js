// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

import { createPluginChannel, isHeadlessRun } from '../../../lib/channels/plugin/adapter.js';
import { withoutSecrets } from '../../../lib/redact.js';
import { isVerificationCommand, verificationExitOf } from '../../../lib/verification.js';
import profile from '../profile.js';
import { createClineModel } from './model.js';

const RETRYABLE_WRITE = new Set(['ELOCKED', 'ESTATEIO', 'EIO', 'EACCES', 'EBUSY', 'EPERM']);
const FRESH_INPUT_MS = 10_000;
const DRAFT_REQUEST = 'Evolver local draft request';
const NATIVE_USER_INPUT = /^<user_input mode="(?:act|plan|yolo)">([\s\S]*)<\/user_input>$/;
const text = (value) => typeof value === 'string' ? value : '';
const id = (value) => text(value).trim() && value.length <= 256 ? value : null;
const messagesOf = (value) => Array.isArray(value) ? value : [];
const messageText = (message) => messagesOf(message?.content)
  .filter((part) => part?.type === 'text').map((part) => text(part.text)).join('\n').trim();

function userInput(message) {
  if (message?.role !== 'user' || !id(message.id) || message.metadata?.displayOnly || message.metadata?.userRunSpan === 0
    || (message.metadata?.displayRole && message.metadata.displayRole !== 'user')) return '';
  const input = messageText(message);
  return NATIVE_USER_INPUT.exec(input)?.[1].trim() ?? input;
}

// Cline uses span zero for both reminders and user steering, but only the latter has its user-input wrapper.
const isSteeringInput = (message) => message?.role === 'user' && message.metadata?.userRunSpan === 0
  && !message.metadata?.displayOnly && NATIVE_USER_INPUT.test(messageText(message));

function nativeCheck(command, callId, result) {
  const output = result?.output;
  if (result?.isError === true || !Array.isArray(output) || output.length !== 1) return null;
  const row = output[0];
  if (row?.query !== command || typeof row.result !== 'string') return null;
  const exit = /^Command exited with code ([1-9]\d*)$/.exec(row.error ?? '');
  if (!(row.success === true && !row.error) && !(row.success === false && exit)) return null;
  return {
    kind: 'shell', callId, command: withoutSecrets(command), output: withoutSecrets(row.result),
    exit: exit ? Number(exit[1]) : null,
    ...(exit && { failed: true }),
  };
}

export function createClinePlugin({ env = process.env } = {}) {
  let channel, cwd, current, warn, distillation, nativeSession, closing = false;
  const sessions = new Map();
  const seenInputs = new Map();
  const verifiedRoutes = new Map();
  const model = createClineModel({ env });

  function channelOf() {
    try {
      return channel ??= createPluginChannel({ profile, env, overrides: {
        model, confirmTurnCompletion: true, persistDistillationInProxy: false,
      } });
    } catch {
      warn?.('Evolver could not open the Cline state directory.');
      return null;
    }
  }

  const matches = (frame, snapshot) => frame && frame.turnId === snapshot?.runId
    && frame.sessionId === snapshot.conversationId && frame.agentId === snapshot.agentId;
  const active = (snapshot) => !closing && !current?.finished && matches(current, snapshot) ? current : null;

  function recall(frame, message) {
    const prompt = userInput(message);
    if (frame.recall || !prompt || seenInputs.get(frame.sessionId) === message.id) return frame.recall;
    frame.promptId = message.id;
    seenInputs.set(frame.sessionId, message.id);
    sessions.set(frame.sessionId, frame.turnId);
    frame.recall = (async () => {
      const reply = await channel.handle('before_run', { ...frame.at, prompt });
      if (frame === current && !frame.finished && !closing) frame.strategy = text(reply?.strategy);
    })();
    return frame.recall;
  }

  async function handleInput(frame, message) {
    const prompt = userInput(message);
    if (prompt === DRAFT_REQUEST || prompt.startsWith(DRAFT_REQUEST + '\n')) {
      if (seenInputs.get(frame.sessionId) !== message.id) {
        seenInputs.set(frame.sessionId, message.id);
        const route = nativeSession && model.capture();
        if (route && route.configDigest === verifiedRoutes.get(frame.sessionId) && !distillation) {
          distillation = channel.handle('command', { ...frame.at, command: 'evolver-distill', args: prompt.slice(DRAFT_REQUEST.length).trim() })
            .then((reply) => { if (!reply.ok) warn?.(withoutSecrets(reply.text || 'Cline distillation did not produce a draft.')); })
            .finally(() => { distillation = null; });
        } else if (!distillation) {
          warn?.('Cline distillation needs a verified turn on the same model and account in this live session.');
        }
      }
      return { stop: true, reason: 'Evolver handled the local draft request.' };
    }
    await recall(frame, message);
  }

  const finish = (frame, reason, answer = '', notes = null) => {
    frame.finished ??= (async () => {
      if (!frame.promptId) return;
      await frame.recall;
      for (let attempt = 0; attempt < 3; attempt++) {
        let failure;
        await channel.handle('after_run', { ...frame.at, reason, answer, notes, model: frame.model,
          strategyDelivered: frame.sentStrategy === true }, { onError: (error) => { failure = error; } });
        if (!failure) {
          if (reason === 'answer' && frame.model) verifiedRoutes.set(frame.sessionId, frame.model.configDigest);
          return;
        }
        if (!RETRYABLE_WRITE.has(failure.code)) break;
        if (attempt < 2) await delay(50);
      }
      warn?.('Evolver could not save the Cline turn.');
    })();
    return frame.finished;
  };

  function beforeTool({ snapshot, toolCall, input }) {
    const frame = active(snapshot);
    if (!frame || toolCall?.toolName !== 'run_commands') return;
    const commands = (input ?? toolCall.input)?.commands;
    if (!Array.isArray(commands) || commands.length !== 1 || typeof commands[0] !== 'string') {
      frame.unsupported = true;
      return;
    }
    const command = commands[0];
    if (!isVerificationCommand(command)) return;
    // shortcut: only an independent check is supported until Cline supplies a verdict for each shell segment.
    if (!id(toolCall.toolCallId) || verificationExitOf(command, 1) !== 1 || frame.calls.has(toolCall.toolCallId)) {
      frame.unsupported = true;
      return;
    }
    frame.calls.set(toolCall.toolCallId, { command, note: null });
  }

  function afterTool({ snapshot, toolCall, input, result }) {
    const frame = active(snapshot);
    if (!frame || toolCall?.toolName !== 'run_commands') return;
    const callId = toolCall.toolCallId;
    const call = frame.calls.get(callId);
    const commands = (input ?? toolCall.input)?.commands;
    if (!call) {
      if (!Array.isArray(commands) || commands.some(isVerificationCommand)) frame.unsupported = true;
      return;
    }
    const note = Array.isArray(commands) && commands.length === 1 && commands[0] === call.command
      ? nativeCheck(call.command, callId, result) : null;
    if (!note || (call.note && !isDeepStrictEqual(call.note, note))) {
      frame.unsupported = true;
      return;
    }
    call.note = note;
  }

  return {
    name: 'evolver-plugin',
    manifest: { capabilities: ['hooks', 'commands'] },
    setup(api, ctx) {
      const project = ctx.workspaceInfo?.rootPath ?? ctx.cwd ?? process.cwd();
      if (!isAbsolute(text(project)) || isHeadlessRun(env, project)) return;
      cwd = project;
      nativeSession = ctx.client?.name === 'cline-cli' && id(ctx.session?.sessionId);
      warn = (message) => ctx.logger?.log?.({ severity: 'warn', message });
      api.registerCommand?.({
        name: 'evolver-distill',
        description: 'Create a private Evolver draft from this Cline session.',
        handler: (input) => ({
          reply: 'Evolver draft requested for this session. Use /evolver-drafts to check local drafts.',
          submitPrompt: [DRAFT_REQUEST, text(input).trim().slice(0, 2_000)].filter(Boolean).join('\n'),
        }),
      });
      api.registerCommand?.({
        name: 'evolver-drafts',
        description: 'List private Evolver drafts in this profile.',
        async handler(input) {
          if (text(input).trim()) return 'Usage: /evolver-drafts';
          const reply = await channelOf()?.handle('command', { cwd, sessionId: 'local-draft-list', command: 'evolver-drafts', args: '' });
          return reply?.text ?? 'Evolver could not read the local drafts.';
        },
      });
      ctx.onDispose?.(async () => {
        if (closing) return;
        closing = true;
        if (!channel) return;
        channel.close();
        try {
          await distillation;
          if (current) await finish(current, 'aborted');
          for (const [sessionId, turnId] of sessions) {
            if (turnId) await channel.handle('session_end', { cwd, sessionId, turnId });
          }
        } finally {
          await channel.idle();
        }
      });
    },
    hooks: {
      async beforeRun({ snapshot }) {
        if (!cwd || closing || snapshot?.parentAgentId || !id(snapshot?.conversationId) || !id(snapshot?.agentId) || !id(snapshot?.runId)
          || matches(current, snapshot)) return;
        if (current) await finish(current, 'aborted');
        if (!channelOf()) return;
        const at = { cwd, sessionId: snapshot.conversationId, turnId: snapshot.runId };
        const history = messagesOf(snapshot.messages);
        const frame = current = { ...at, at, agentId: snapshot.agentId, tail: history.at(-1)?.id,
          calls: new Map(), unsupported: false };
        if (!sessions.has(at.sessionId)) {
          await channel.handle('session_start', at);
          sessions.set(at.sessionId, null);
        }
        // The CLI seeds the current prompt before this hook. An old trailing user message on resume cannot open a turn.
        const last = history.at(-1);
        const age = Date.now() - last?.createdAt;
        if (age >= 0 && age <= FRESH_INPUT_MS) return handleInput(frame, last);
      },
      async beforeModel({ snapshot, request }) {
        const frame = active(snapshot);
        if (!frame || request?.signal?.aborted) return;
        const messages = messagesOf(request?.messages);
        if (!frame.promptId && snapshot.iteration === 1) {
          const historyEnd = frame.tail ? messages.findIndex((message) => message.id === frame.tail) : -1;
          if (!frame.tail || historyEnd >= 0) {
            const input = messages.slice(historyEnd + 1).filter(userInput);
            if (input.length === 1) {
              const command = await handleInput(frame, input[0]);
              if (command) return command;
            }
          }
        }
        const index = messages.findIndex((message) => message.id === frame.promptId);
        if (index >= 0 && messages.slice(index + 1).some(isSteeringInput)) frame.steered = true;
        if (frame.steered) return;
        const selected = nativeSession ? model.capture() : null;
        if (frame.model === undefined) frame.model = selected;
        else if (frame.model?.configDigest !== selected?.configDigest) frame.model = null;
        if (!frame.strategy || !active(snapshot) || request?.signal?.aborted) return;
        if (index < 0) return;
        const context = { id: `evolver-${frame.turnId}`, role: 'user', createdAt: messages[index].createdAt,
          content: [{ type: 'text', text: frame.strategy }] };
        frame.sentStrategy = true;
        // Alter the outbound request, keeping Recipe context out of Cline's persisted conversation.
        return { messages: [...messages.slice(0, index + 1), context, ...messages.slice(index + 1)] };
      },
      afterModel({ snapshot, assistantMessage }) {
        const frame = active(snapshot);
        if (!frame?.model) return;
        const { selection, configDigest } = frame.model;
        if (assistantMessage?.modelInfo?.provider !== selection.providerId || assistantMessage?.modelInfo?.id !== selection.modelId
          || model.capture()?.configDigest !== configDigest) frame.model = null;
      },
      beforeTool,
      afterTool,
      async afterRun({ snapshot, result }) {
        const frame = active(snapshot);
        if (!frame || !matches(frame, { ...snapshot, runId: result?.runId, agentId: result?.agentId })) return;
        if (result.status === 'aborted') return finish(frame, 'aborted');
        const messages = messagesOf(result.messages);
        const input = messages.findIndex((message) => message.id === frame.promptId);
        const last = messages.at(-1);
        const answer = text(result.outputText).trim();
        const notes = [...frame.calls.values()].map(({ note }) => note);
        const complete = result.status === 'completed' && input >= 0 && input < messages.length - 1
          && last?.role === 'assistant' && messageText(last) && answer && notes.length > 0
          && !frame.steered && !messages.slice(input + 1).some(isSteeringInput)
          && (!frame.strategy || frame.sentStrategy) && !frame.unsupported && notes.every(Boolean);
        if (frame.model) {
          const { selection, configDigest } = frame.model;
          if (last?.modelInfo?.provider !== selection.providerId || last?.modelInfo?.id !== selection.modelId
            || model.capture()?.configDigest !== configDigest) frame.model = null;
        }
        return complete ? finish(frame, 'answer', answer, notes) : finish(frame, 'error');
      },
    },
  };
}

export default createClinePlugin();
