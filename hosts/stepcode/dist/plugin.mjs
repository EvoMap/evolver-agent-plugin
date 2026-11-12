// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

import { commandCatalog, hostCommandCatalog, createPluginChannel, isHeadlessRun } from '../../../lib/channels/plugin/adapter.js';
import profile from '../profile.js';
import { editedFilesOf } from '../tools.js';
import { stepModel } from './model.js';

const text = (value) => typeof value === 'string' ? value : '';
const RETRYABLE_STATE_ERRORS = new Set(['ELOCKED', 'ESTATEIO', 'EIO', 'EACCES', 'EBUSY', 'EPERM']);
const answerOf = (message) => message?.role === 'assistant'
  ? (message.content ?? []).filter((part) => part?.type === 'text').map((part) => text(part.text)).join('\n').trim() : '';

/** Step's extension callbacks surround one user prompt, which can contain several low-level turns. */
export default function evolverStep(pi) {
  if (isHeadlessRun()) return;
  const model = stepModel();
  const channel = createPluginChannel({ profile, overrides: { model, confirmTurnCompletion: true } });
  const started = new Set();
  let frame = null, closing = false, commandPrompt = null;

  const fields = (ctx) => {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    return typeof sessionId === 'string' && sessionId && sessionId.length <= 256 && isAbsolute(text(ctx.cwd))
      ? { sessionId, cwd: ctx.cwd } : null;
  };
  const notify = (ctx, answer) => {
    const content = answer?.notice || answer?.text;
    if (content) ctx.ui?.notify?.(content, answer.ok === false ? 'error' : 'info');
  };
  const capture = async (ctx) => {
    try { return await model.captureContext(ctx); } catch { return null; }
  };
  const start = async (ctx) => {
    const at = fields(ctx);
    if (!at || closing) return null;
    if (!started.has(at.sessionId)) {
      await capture(ctx);
      started.add(at.sessionId);
      notify(ctx, await channel.handle('session_start', at));
    }
    return at;
  };
  const watch = (ctx) => {
    if (!frame || fields(ctx)?.sessionId !== frame.sessionId) return;
    const current = frame, signal = ctx.signal;
    if (!signal || current.signals.has(signal)) return;
    const aborted = () => { current.aborted = true; };
    current.signals.set(signal, aborted);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  };
  const forget = (current) => {
    for (const [signal, listener] of current.signals) signal.removeEventListener('abort', listener);
    current.signals.clear();
    current.calls.clear();
    if (frame === current) frame = null;
  };
  const finish = (current, reason, ctx) => {
    if (current.ended) return current.finished;
    current.ended = true;
    const payload = { sessionId: current.sessionId, cwd: current.cwd,
      turnId: current.turnId, answer: current.answer, reason, model: current.model };
    current.finished = (async () => {
      try {
        // Step has no terminal record reader: retain its native proof until transient writes can be retried.
        for (let attempt = 0; attempt < 3; attempt++) {
          let failure;
          await channel.handle('agent_settled', payload, { onError: (error) => { failure = error; } });
          if (!failure) return;
          if (!RETRYABLE_STATE_ERRORS.has(failure.code)) break;
          if (attempt < 2) await delay(50);
        }
        notify(ctx, { ok: false, text: 'Evolver could not finish saving this turn. Check the local state directory before continuing.' });
      } finally { forget(current); }
    })();
    return current.finished;
  };

  pi.on('session_start', async (_event, ctx) => { await start(ctx); });
  pi.on('before_agent_start', async (event, ctx) => {
    const at = await start(ctx);
    if (!at) return;
    if (frame) await finish(frame, 'aborted', ctx);
    const command = commandPrompt?.text === event.prompt ? commandPrompt : null;
    if (command) commandPrompt = null;
    const current = { ...at, turnId: randomUUID(), model: await capture(ctx), strategy: '', answer: '',
      stopReason: '', aborted: false, unsupported: false, ended: false, calls: new Map(), signals: new Map(), nextCall: 0 };
    frame = current;
    const reply = await channel.handle('before_agent_start', { ...at, turnId: current.turnId, prompt: text(event.prompt), model: current.model,
      ...(command && { command: command.name, arguments: command.args }) });
    if (frame === current && !current.ended) current.strategy = text(reply.strategy);
    watch(ctx);
  });
  pi.on('agent_start', (_event, ctx) => { watch(ctx); });
  pi.on('context', (event, ctx) => {
    watch(ctx);
    const current = frame;
    if (!current || current.ended || current.aborted || fields(ctx)?.sessionId !== current.sessionId || !current.strategy) return;
    return { messages: [...event.messages, { role: 'user', content: current.strategy, timestamp: Date.now() }] };
  });
  pi.on('tool_call', async (event, ctx) => {
    watch(ctx);
    const current = frame;
    if (!current || current.ended || current.aborted || !text(event.toolCallId) || fields(ctx)?.sessionId !== current.sessionId) return;
    if (current.calls.has(event.toolCallId)) { current.unsupported = true; return; }
    const call = { toolCallId: `${current.turnId}:${++current.nextCall}`, toolName: text(event.toolName), input: structuredClone(event.input) };
    current.calls.set(event.toolCallId, call);
    if (text(event.input?.then_run).trim()) current.unsupported = true;
    const payload = { sessionId: current.sessionId, cwd: current.cwd, turnId: current.turnId, ...call };
    await channel.handle('tool_call', payload);
    await channel.handle('tool_start', payload);
  });
  pi.on('tool_result', async (event, ctx) => {
    watch(ctx);
    const current = frame, call = current?.calls.get(event.toolCallId);
    if (!current || current.ended || !call || fields(ctx)?.sessionId !== current.sessionId) return;
    current.calls.delete(event.toolCallId);
    if (event.toolName !== call.toolName) { current.unsupported = true; return; }
    // Later extensions may change arguments; an edit must retain the path whose baseline we captured.
    const paths = (payload) => editedFilesOf({ ...payload, cwd: current.cwd }, { env: process.env });
    if (!isDeepStrictEqual(paths(call), paths(event)) || text(event.input?.then_run).trim()
      || event.details?.thenRun || event.details?.execution?.status === 'running') current.unsupported = true;
    const reply = await channel.handle('tool_result', { ...event, toolCallId: call.toolCallId, sessionId: current.sessionId, cwd: current.cwd, turnId: current.turnId });
    if (reply.strategy && !current.strategy.includes(reply.strategy)) current.strategy = [current.strategy, reply.strategy].filter(Boolean).join('\n\n');
  });
  pi.on('turn_end', (event, ctx) => {
    watch(ctx);
    if (!frame || frame.ended || fields(ctx)?.sessionId !== frame.sessionId || event.message?.role !== 'assistant') return;
    frame.answer = answerOf(event.message);
    frame.stopReason = text(event.message.stopReason);
  });
  pi.on('agent_settled', async (event, ctx) => {
    watch(ctx);
    const current = frame;
    if (!current || current.ended || fields(ctx)?.sessionId !== current.sessionId) return;
    const confirmed = !current.aborted && !current.unsupported && current.signals.size > 0 && current.calls.size === 0
      && ctx.isIdle?.() === true && ctx.hasPendingMessages?.() === false && !event.failure
      && current.stopReason === 'stop' && Boolean(current.answer);
    await finish(current, current.aborted ? 'aborted' : confirmed ? 'answer' : 'error', ctx);
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    if (closing) return;
    closing = true;
    commandPrompt = null;
    channel.close();
    model.clear();
    if (frame) await finish(frame, 'aborted', ctx);
    const at = fields(ctx);
    if (at) await channel.handle('session_shutdown', at);
    await channel.idle();
  });
  for (const command of [...commandCatalog, ...hostCommandCatalog.filter((entry) => entry.name === 'evolver-config')]) pi.registerCommand(command.name, {
    description: command.description,
    handler: async (args, ctx) => {
      const at = await start(ctx);
      if (!at) return;
      await capture(ctx);
      const answer = await channel.handle('command', { ...at, command: command.name, arguments: text(args) });
      if (!answer.ok || !answer.forAgent) return notify(ctx, answer);
      if (typeof pi.sendUserMessage !== 'function') return notify(ctx, { ok: false, text: 'This Step Code runtime cannot start an evolution prompt.' });
      commandPrompt = { text: answer.text, name: command.name, args: text(args) };
      try { pi.sendUserMessage(answer.text); }
      catch { commandPrompt = null; notify(ctx, { ok: false, text: 'Step Code could not start the evolution prompt.' }); }
    },
  });
}
