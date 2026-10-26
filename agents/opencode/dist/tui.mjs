// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { COMMANDS } from '../../../lib/app/commands/index.js';
import { createPluginChannel } from '../../../lib/channels/plugin/adapter.js';
import { evolverCliOf } from '../../../lib/runtime/cli-executor.js';
import profile from '../profile.js';
import { helperModel, tuiSessions } from './helper-session.js';
import { pluginEnv } from './options.js';

// OpenCode's own slash commands are prompt templates the model answers. Only a TUI plugin can register a command
// that runs code of its own, so the /evolver-* commands live here and answer in a dialog; a command that takes
// text asks for it in a prompt dialog first, since a TUI command receives no arguments. /evolver-evolve is the
// server plugin's prompt command, since reflecting on the work is the agent's job.

const PROMPT_COMMANDS = new Set(['evolver-evolve']);
const SESSION_COMMANDS = new Set(['evolver-search', 'evolver-distill']);
const NO_SESSION = 'opencode-tui';

function openSessionOf(api) {
  const route = api.route.current;
  return route?.name === 'session' ? route.params?.sessionID : undefined;
}

function showResult(api, command, { ok, text }) {
  const title = ok === false ? `/${command.name} failed` : `/${command.name}`;
  api.ui.dialog.replace(() => api.ui.DialogAlert({ title, message: text || 'Done.', onConfirm: () => api.ui.dialog.clear() }));
}

// A strategy the person searched for joins the session as hidden text, so the model has what the next turn's
// report says it reused.
function addToConversation(api, sessionID, part) {
  return api.client.session.prompt({ sessionID, noReply: true, parts: [part] }).catch(() => {});
}

async function run(api, channel, command, rawInput) {
  const sessionID = openSessionOf(api);
  if (!sessionID && SESSION_COMMANDS.has(command.name)) {
    showResult(api, command, { ok: false, text: `Open a session first: /${command.name} works on that session.` });
    return;
  }
  api.ui.toast({ variant: 'info', message: `Running /${command.name}…` });
  const answer = await channel.handle('tui.command', { sessionID: sessionID ?? NO_SESSION, command: command.name, arguments: rawInput });
  if (answer.part) await addToConversation(api, sessionID, answer.part);
  showResult(api, command, answer);
}

function askThenRun(api, channel, command) {
  api.ui.dialog.replace(() => api.ui.DialogPrompt({
    title: `/${command.name}`,
    placeholder: command.hint,
    onConfirm: (value) => {
      api.ui.dialog.clear();
      run(api, channel, command, value ?? '');
    },
    onCancel: () => api.ui.dialog.clear(),
  }));
}

function paletteCommandOf(api, channel, command) {
  return {
    name: `evomap.${command.name}`,
    title: `/${command.name}`,
    desc: command.description,
    category: 'Evolver',
    namespace: 'palette',
    slashName: command.name,
    run: () => (command.hint ? askThenRun(api, channel, command) : run(api, channel, command, '')),
  };
}

async function tui(api, options) {
  const channel = createPluginChannel({
    profile,
    env: pluginEnv(options, process.env),
    overrides: { model: helperModel(tuiSessions(api.client)), cli: evolverCliOf({ cwd: api.state.path.directory }) },
  });
  const commands = COMMANDS.filter((command) => !PROMPT_COMMANDS.has(command.name));
  api.keymap.registerLayer({ commands: commands.map((command) => paletteCommandOf(api, channel, command)) });
}

// Nothing else is exported: OpenCode's legacy loader takes every export of a module for a plugin function.
export default { id: 'evomap.evolver', tui };
