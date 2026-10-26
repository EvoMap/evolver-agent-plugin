// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// A WorkBuddy command is a prompt whose inline `!` script the host runs while it renders the command, so the
// command still reaches the model as a turn: typed (`/evolver-status`, `/evolver:evolver-status`) or rendered
// (`<command-name>/evolver:evolver-status</command-name>` followed by the script's output).

export const AGENT_NAME = 'workbuddy';
export const AGENT_GENE_MARK = 'EVOLVER: WRITE THE GENE YOURSELF';

const TYPED = /^\/(?:[\w-]+:)?(evolver-[\w-]+)(?:[ \t]+([\s\S]*))?$/;
const RENDERED = /<command-name>\/(?:[\w-]+:)?(evolver-[\w-]+)<\/command-name>/;
// The host leaves `$ARGUMENTS` in place when a command is given no argument.
const UNSUBSTITUTED = '$ARGUMENTS';
const SCRIPT_EVENTS = new Set(['Command', 'AgentGene']);
const NO_ANSWER = 'Evolver gave no answer: the command ran outside a WorkBuddy session (no CODEBUDDY_SESSION_ID), or it failed.';

function argumentsText(text) {
  const trimmed = String(text ?? '').trim();
  return trimmed === UNSUBSTITUTED ? '' : trimmed;
}

/** The `/evolver-…` command a prompt is, typed or as the host rendered it, with its argument text; else null. */
export function evolverCommandOf(prompt) {
  const text = String(prompt ?? '').trim();
  const typed = TYPED.exec(text);
  if (typed) return { name: typed[1], args: argumentsText(typed[2]) };
  const rendered = RENDERED.exec(text);
  return rendered ? { name: rendered[1], args: '' } : null;
}

export const sessionOfCommand = (env) => env.CODEBUDDY_SESSION_ID || env.CLAUDE_SESSION_ID || null;

const shellQuoted = (text) => `'${String(text).replaceAll("'", `'\\''`)}'`;

/**
 * The Gene request handed to the agent when the headless CLI wrote none (inside the app it cannot sign in). The
 * agent's shell carries neither the session nor the plugin data folder, so the command names both; its heredoc
 * ends on a line made of this run's nonce, so no line of the Gene can end it early and run as shell.
 */
function agentGeneRequest({ text, agentGene }, payload) {
  const end = `EVOLVER_GENE_${payload.nonce}`;
  const env = [
    `CODEBUDDY_SESSION_ID=${shellQuoted(payload.session_id)}`,
    ...(payload.state_dir ? [`CODEBUDDY_PLUGIN_DATA=${shellQuoted(payload.state_dir)}`] : []),
  ];
  return [
    AGENT_GENE_MARK,
    `The headless CodeBuddy model could not distill this session's latest verified turn (${text.replace(/\.$/, '')}).`,
    'Write the Gene with your own model: answer the request below with the JSON object only, put it between the',
    'two marker lines of this command, run the command with your shell tool, and show the user what it prints.',
    '',
    `${env.join(' ')} node ${shellQuoted(payload.script)} ${AGENT_NAME} evolver-distill --post ${agentGene.writtenFor} <<'${end}'`,
    '<the JSON object>',
    end,
    '',
    agentGene.prompt,
  ].join('\n');
}

/** A command's answer is the text its script prints, for the agent to show or, for a Gene request, to act on. */
export const commandAnswer = (result, hostEvent, payload) => (result.agentGene ? agentGeneRequest(result, payload) : result.text);

export const emptyAnswer = (hostEvent) => (SCRIPT_EVENTS.has(hostEvent) ? NO_ANSWER : {});
