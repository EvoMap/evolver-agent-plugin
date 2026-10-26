// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { homedir } from 'node:os';
import { join } from 'node:path';

import { typedCommandOf } from '../app/commands/index.js';
import { OBSERVED } from '../app/turn-reports.js';
import { additionalContextReply, claudeStylePayload, hookTurnEnd } from './defaults/hook.js';
import { mcpCommands, mcpEvents, mcpEvidence, mcpPayload, mcpReply, mcpTurnEnd } from './defaults/mcp.js';
import { CHANNELS, COMMAND_ENTRIES, EVENTS } from './events.js';

// An agent is described by where it differs from the usual: an AgentProfile names its channel, how to read its
// payloads, how to answer them, where its evidence comes from, and declares what the runtime should execute for it
// (time budgets, the owner process, the headless model, where state lives). Everything else comes from defaults.

const defaultStateDir = (env) => join(env.HOME || env.USERPROFILE || homedir(), '.evolver', 'state');
const typedFromPrompt = (payload, hostEvent, { prompt }) => typedCommandOf(prompt);
const listOfEditedFile = (editedFile) => (typeof editedFile === 'function' ? (payload, context) => [editedFile(payload, context)].filter(Boolean) : undefined);

const COMMON = Object.freeze({
  sessionStart: 'event',
  model: null,
  budgets: Object.freeze({}),
  stateDir: defaultStateDir,
  legacy: Object.freeze([]),
  payload: Object.freeze({ transcriptPath: (payload) => payload.transcript_path ?? null, gene: (payload) => payload.gene, writtenFor: (payload) => Number(payload.written_for) }),
  commands: Object.freeze({ entry: COMMAND_ENTRIES.CLI_ONLY, parse: typedFromPrompt, answerReachesModel: false }),
});

const BY_CHANNEL = Object.freeze({
  [CHANNELS.HOOK]: { owner: 'parent', payload: claudeStylePayload, reply: additionalContextReply, turnEnd: hookTurnEnd, budgets: { prompt: 5_000 } },
  [CHANNELS.PLUGIN]: { owner: 'self', payload: {}, reply: {}, turnEnd: hookTurnEnd },
  [CHANNELS.MCP]: {
    owner: 'self', events: mcpEvents, payload: mcpPayload, reply: mcpReply, turnEnd: mcpTurnEnd, evidence: mcpEvidence,
    commands: mcpCommands, sessionStart: 'connection', model: { kind: 'in-session' },
  },
});

const NESTED = ['payload', 'reply', 'turnEnd', 'commands', 'evidence', 'budgets'];
const REPLY_FUNCTIONS = ['context', 'notice', 'empty', 'command', 'turnEnd'];
const PAYLOAD_FUNCTIONS = ['sessionId', 'turnId', 'prompt', 'projectDir', 'isIgnored', 'model', 'transcriptPath', 'gene', 'writtenFor'];
const MODEL_KINDS = ['cli', 'sdk', 'in-session'];

function merged(layers) {
  const result = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      result[key] = NESTED.includes(key) ? { ...(result[key] ?? {}), ...value } : value;
    }
  }
  return result;
}

function problemsOf(profile) {
  const problems = [];
  const isFunction = (value) => typeof value === 'function';
  if (!/^[a-z][a-z0-9-]*$/.test(profile.name ?? '')) problems.push('name must be lower-case letters, digits and dashes');
  if (!profile.label) problems.push('label is required');
  if (!Object.values(CHANNELS).includes(profile.channel)) problems.push(`channel must be one of ${Object.values(CHANNELS).join(', ')}`);
  const events = Object.values(profile.events ?? {});
  if (events.length === 0 || events.some((event) => !Object.values(EVENTS).includes(event))) problems.push('events must map host events to canonical events');
  for (const name of PAYLOAD_FUNCTIONS) if (!isFunction(profile.payload?.[name])) problems.push(`payload.${name} must be a function`);
  for (const name of REPLY_FUNCTIONS) if (!isFunction(profile.reply?.[name])) problems.push(`reply.${name} must be a function`);
  if (!['turn', 'call'].includes(profile.reply?.lifetime)) problems.push("reply.lifetime must be 'turn' or 'call'");
  if (!profile.evidence || !isFunction(profile.evidence.toolNote) || !isFunction(profile.evidence.editedFiles)) problems.push('evidence.toolNote and evidence.editedFile or editedFiles are required');
  if (!isFunction(profile.turnEnd?.reason) || !isFunction(profile.turnEnd?.answer)) problems.push('turnEnd.reason and turnEnd.answer must be functions');
  if (!Object.values(COMMAND_ENTRIES).includes(profile.commands?.entry) || !isFunction(profile.commands?.parse)) problems.push('commands.entry and commands.parse are required');
  const isOwner = profile.owner === 'self' || profile.owner === 'parent' || profile.owner?.ancestor instanceof RegExp || profile.owner?.ancestorPath instanceof RegExp;
  if (!isOwner) problems.push("owner must be 'self', 'parent', { ancestor: RegExp } or { ancestorPath: RegExp }");
  if (profile.model !== null && !MODEL_KINDS.includes(profile.model?.kind)) problems.push(`model must be null or of kind ${MODEL_KINDS.join(', ')}`);
  if (Object.values(profile.budgets).some((budget) => !Number.isFinite(budget))) problems.push('budgets must be milliseconds');
  if (!isFunction(profile.stateDir)) problems.push('stateDir must be a function of the environment');
  if (!Array.isArray(profile.legacy)) problems.push('legacy must be a list of leftovers to adopt');
  return problems;
}

/** Completes an agent's profile with the defaults of its channel and checks it; a wrong profile fails on load. */
export function defineProfile(spec) {
  const profile = merged([COMMON, BY_CHANNEL[spec.channel ?? CHANNELS.HOOK], { channel: CHANNELS.HOOK }, spec]);
  profile.evidence = profile.evidence && { source: OBSERVED, editedFiles: listOfEditedFile(profile.evidence.editedFile), ...profile.evidence };
  const problems = problemsOf(profile);
  if (problems.length > 0) throw new Error(`Agent profile "${spec.name}": ${problems.join('; ')}.`);
  return Object.freeze(profile);
}
