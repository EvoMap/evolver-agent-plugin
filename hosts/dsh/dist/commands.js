// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { commandCatalog } from '../../../lib/channels/plugin/adapter.js';
import { instructionsMessage, strategyMessage } from './plugin-messages.js';

const resultOf = (command, answer) => (answer.ok === false
  ? { kind: 'error', text: answer.text || `/${command.name} failed.` }
  : { kind: 'success', text: answer.text });

// dsh answers a command in its UI and never shows it to the model, so a command meant for the agent becomes a
// follow-up turn of its own, and a strategy a search found joins the conversation at the next step.
async function answered(command, { agent, rawInput, signal }, { run, rememberPrompt }) {
  const answer = await run(agent.session, { command: command.name, arguments: rawInput }, signal);
  if (answer.forAgent && answer.ok !== false) {
    const message = instructionsMessage(answer.text);
    rememberPrompt(message.id, command.name);
    agent.followup(message);
    return { kind: 'success', text: `Running /${command.name}.` };
  }
  if (answer.strategy) agent.inject(strategyMessage(answer.strategy));
  return resultOf(command, answer);
}

export function registerCommands(commands, ports) {
  for (const command of commandCatalog) {
    commands.register({
      name: command.name,
      description: command.description,
      ...(command.hint && { input: { hint: command.hint } }),
      handler: (invocation) => answered(command, invocation, ports),
    });
  }
}
