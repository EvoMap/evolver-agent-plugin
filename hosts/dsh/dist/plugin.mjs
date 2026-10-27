// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { realpathSync } from 'node:fs';

import { createPluginChannel } from '../../../lib/channels/plugin/adapter.js';
import profile from '../profile.js';
import { registerCommands } from './commands.js';
import { dshModel } from './model.js';
import { Config, pluginEnv } from './options.js';
import { noticeMessage, strategyMessage } from './plugin-messages.js';
import { createTurnTracker } from './turns.js';

export const name = 'evolver-plugin';
export const inject = ['tools'];
export { Config };

const FIRST_STEP = 1;

function realDir(dir) {
  if (typeof dir !== 'string' || !dir) return null;
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

// dsh does not wait for its session events, so each session's host events are handed over one after another in the
// order dsh raised them: a turn's end is settled before the next step opens a turn.
function inOrderPerSession() {
  const tails = new Map();
  return (sessionId, work) => {
    const done = (tails.get(sessionId) ?? Promise.resolve()).then(work).catch(() => ({}));
    tails.set(sessionId, done);
    done.then(() => tails.get(sessionId) === done && tails.delete(sessionId));
    return done;
  };
}

export function apply(ctx, config) {
  let llm = null;
  ctx.inject(['llm'], (scoped) => {
    llm = scoped.llm;
  });
  const channel = createPluginChannel({ profile, env: pluginEnv(config, process.env), overrides: { model: dshModel(() => llm) } });
  const turns = createTurnTracker();
  const inOrder = inOrderPerSession();
  const dirs = new Map();
  const started = new Map();
  const commandPrompts = new Map();

  const fieldsOf = (session) => {
    if (!dirs.has(session.id)) dirs.set(session.id, realDir(session.header?.cwd));
    return { sessionId: session.id, cwd: dirs.get(session.id), origin: session.header?.origin ?? null };
  };
  const raise = (hostEvent, session, fields = {}) => {
    const payload = { ...fieldsOf(session), ...fields };
    return inOrder(session.id, () => channel.handle(hostEvent, payload));
  };

  const startSession = (hostEvent, agent, source = null) => {
    if (started.has(agent.session.id)) return;
    started.set(agent.session.id, agent.session);
    raise(hostEvent, agent.session, { source }).then((answer) => answer.notice && agent.inject(noticeMessage(answer.notice))).catch(() => {});
  };

  const commandOf = (messages) => {
    const prompt = messages.find((message) => commandPrompts.has(message.id));
    if (!prompt) return undefined;
    const command = commandPrompts.get(prompt.id);
    commandPrompts.delete(prompt.id);
    return command;
  };

  // A recall slower than the step's wait keeps going; when it lands while its turn still runs, it joins the turn's
  // next step and is booked then, since a strategy no model request carried was not used.
  const keepLate = (sessionId, turn, late) => late.then((landed) => landed && turns.landLate(sessionId, turn, landed)).catch(() => {});

  async function promptStep(agent, turn, messages) {
    startSession('agent/created', agent);
    turns.open(agent.session.id, turn);
    const answer = await raise('agent/pre-step', agent.session, { turn, messages, command: commandOf(messages) });
    if (answer.late) keepLate(agent.session.id, turn, answer.late);
    return answer.strategy ? strategyMessage(answer.strategy) : null;
  }

  async function laterStep(session, turn) {
    const landed = turns.takeLate(session.id, turn);
    return landed && (await landed.join()) ? strategyMessage(landed.text) : null;
  }

  ctx.on('agent/created', ({ agent, source }) => startSession('agent/created', agent, source));
  ctx.on('agent/session-start', ({ agent, source }) => startSession('agent/session-start', agent, source));

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    const { agent, turn, step, signal } = payload;
    if (decision.kind !== 'enter' || signal?.aborted) return decision;
    const added = step === FIRST_STEP ? await promptStep(agent, turn, decision.messages) : await laterStep(agent.session, turn);
    return added && !signal?.aborted ? { ...decision, messages: [...decision.messages, added] } : decision;
  });

  ctx.on('tools/execute', async (exec, next) => {
    const session = exec.agent?.session;
    if (!session) return next();
    const call = { turn: turns.openTurnOf(session.id), name: exec.name, arguments: exec.arguments };
    await raise('tools/execute:before', session, call);
    const result = await next();
    raise('tools/execute', session, { ...call, result });
    return result;
  });

  ctx.on('session/event', (session, { type, data = {} } = {}) => {
    if (type === 'assistant/message') turns.noteAssistant(session.id, data.turn, data.message);
    if (type !== 'turn/end') return;
    const { lastAssistant, answer } = turns.close(session.id, data.turn);
    raise('turn/end', session, { turn: data.turn, reason: data.reason, lastAssistant, answer });
  });

  ctx.on('session/disposed', (session) => {
    raise('session/disposed', session);
    started.delete(session.id);
    turns.forget(session.id);
    dirs.delete(session.id);
  });

  ctx.inject(['commands'], (scoped) => registerCommands(scoped.commands, {
    run: (session, fields, signal) => channel.handle('command/run', { ...fieldsOf(session), ...fields }, { signal }),
    rememberPrompt: (messageId, command) => commandPrompts.set(messageId, command),
  }));

  // dsh unloads its plugins before it retires the sessions (a headless run never raises `session/disposed`), so the
  // plugin's unload ends them; what they leave is only written, and the next session start delivers and distills it.
  ctx.effect(() => async () => {
    channel.close();
    await Promise.all([...started.values()].map((session) => channel.handle('dispose', fieldsOf(session))));
  }, 'evolver: end the open sessions');
}
