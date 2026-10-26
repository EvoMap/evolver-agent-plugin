// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { realpathSync } from 'node:fs';

import { EVOLVE_PROMPT, commandCatalog, createPluginChannel } from '../../../lib/channels/plugin/adapter.js';
import profile from '../profile.js';
import { helperModel, serverSessions } from './helper-session.js';
import { pluginEnv } from './options.js';
import { placedPart } from './parts.js';
import { createSessionInfos } from './session-infos.js';
import { createTurnTracker } from './turns.js';

const EVOLVE = 'evolver-evolve';
const NOTICE_MS = 15_000;

function projectDirOf(directory) {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

// OpenCode does not wait for its event hook, so each session's host events are handed over one after another in
// the order OpenCode raised them: a turn's end is settled before the next prompt opens a turn.
function inOrderPerSession() {
  const tails = new Map();
  return (sessionID, work) => {
    const done = (tails.get(sessionID) ?? Promise.resolve()).then(work);
    const tail = done.catch(() => {});
    tails.set(sessionID, tail);
    tail.then(() => tails.get(sessionID) === tail && tails.delete(sessionID));
    return done;
  };
}

/**
 * Nothing of Evolver but the recalled strategy enters the model's context: no tools, no skill, no instructions.
 * The person reaches it through the TUI plugin's /evolver-* commands; only /evolver-evolve is a prompt command.
 */
async function EvolverServer(input, options) {
  const directory = projectDirOf(input.directory);
  const model = helperModel(serverSessions(input.client));
  const channel = createPluginChannel({ profile, env: pluginEnv(options, process.env), overrides: { model } });
  const infos = createSessionInfos(async (id) => (await input.client.session.get({ path: { id } }))?.data);
  const turns = createTurnTracker();
  const inOrder = inOrderPerSession();
  const started = new Set();
  const deleted = new Set();
  const evolving = new Set();

  const toast = (answer) => {
    if (answer?.toast) input.client.tui.showToast({ body: { message: answer.toast, variant: 'info', duration: NOTICE_MS } }).catch(() => {});
  };

  const raise = (hostEvent, sessionID, fields = {}) => inOrder(sessionID, async () =>
    channel.handle(hostEvent, { sessionID, directory, session: await infos.of(sessionID), ...fields }));

  const endTurn = async (sessionID) => {
    const ended = turns.close(sessionID);
    if (ended) await raise('session.idle', sessionID, ended);
  };

  const startSession = (sessionID) => {
    if (started.has(sessionID)) return;
    started.add(sessionID);
    raise('session.start', sessionID).then(toast);
  };

  const onEvent = {
    'session.created': ({ info }) => infos.note(info),
    'session.status': ({ sessionID, status }) => {
      turns.noteStatus(sessionID, status);
      return status?.type === 'idle' ? endTurn(sessionID) : undefined;
    },
    'message.updated': ({ info }) => {
      if (info?.role === 'assistant') turns.noteAssistant(info.sessionID, info);
    },
    'session.error': ({ sessionID, error }) => turns.noteError(sessionID, error),
    'session.deleted': ({ sessionID, info }) => {
      infos.note(info);
      deleted.add(sessionID);
      started.delete(sessionID);
      turns.close(sessionID);
      return raise('session.deleted', sessionID);
    },
  };

  return {
    config: async (cfg) => {
      const evolve = commandCatalog.find((command) => command.name === EVOLVE);
      cfg.command = { [EVOLVE]: { description: evolve.description, template: EVOLVE_PROMPT }, ...cfg.command };
    },

    'command.execute.before': async ({ command, sessionID, arguments: rawInput }, output) => {
      if (command !== EVOLVE) return;
      evolving.add(sessionID);
      const answer = await raise('command.execute.before', sessionID, { command, arguments: rawInput });
      const part = output.parts.find((candidate) => candidate?.type === 'text');
      if (part && answer.ok) part.text = answer.text;
    },

    // A message with no part the person wrote (another plugin's note, a searched strategy) starts no turn, and a
    // prompt sent while its session is busy joins the running turn.
    'chat.message': async ({ sessionID }, output) => {
      if (output.parts.every((part) => part?.synthetic)) return;
      const command = evolving.delete(sessionID) ? EVOLVE : undefined;
      await infos.of(sessionID);
      if (deleted.has(sessionID)) return;
      if (turns.isOpen(sessionID)) {
        if (turns.isBusy(sessionID)) return;
        await endTurn(sessionID);
      }
      turns.open(sessionID, output.message.id);
      startSession(sessionID);
      const answer = await raise('chat.message', sessionID, { turnID: output.message.id, parts: output.parts, command });
      if (answer.part) output.parts.push(placedPart(sessionID, output.message.id, answer.part));
    },

    'tool.execute.before': async ({ tool, sessionID }, output) => {
      if (turns.isOpen(sessionID)) await raise('tool.execute.before', sessionID, { tool, args: output.args });
    },

    'tool.execute.after': async ({ tool, sessionID, args }, output) => {
      if (turns.isOpen(sessionID)) await raise('tool.execute.after', sessionID, { tool, args, result: { output: output?.output, metadata: output?.metadata } });
    },

    'experimental.text.complete': async ({ sessionID, messageID }, output) => turns.noteText(sessionID, messageID, output.text),

    event: async ({ event }) => onEvent[event?.type]?.(event.properties ?? {}),

    // Shutdown waits five seconds at most, too short for delivery or a model call: what the sessions leave is only
    // written, and the next start delivers and distills it.
    dispose: async () => {
      channel.close();
      await Promise.all([...started].map((sessionID) => raise('dispose', sessionID)));
    },
  };
}

// Nothing else is exported: OpenCode's legacy loader takes every export of a module for a plugin function.
export default { id: 'evomap.evolver', server: EvolverServer };
