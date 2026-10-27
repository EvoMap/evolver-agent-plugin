// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { AGENT_REPORTED } from '../../app/turn-reports.js';
import { EVENTS } from '../events.js';

// An agent without hooks reaches Evolver through MCP tools. The connection is the session; a turn runs from the
// agent's `evolver_recall` to its `evolver_report`, and what the turn did is what the agent reports, which is
// evidence of a weaker kind than a hook's own observation.

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const list = (value) => (Array.isArray(value) ? value : []);

export const MCP_TOOLS = Object.freeze({
  RECALL: 'evolver_recall',
  REPORT: 'evolver_report',
  DISTILL: 'evolver_distill',
  STATUS: 'evolver_status',
  SEARCH: 'evolver_search',
  DRAFTS: 'evolver_drafts',
  LOGIN: 'evolver_login',
});

export const mcpEvents = Object.freeze({
  initialize: EVENTS.SESSION_START,
  [MCP_TOOLS.RECALL]: EVENTS.PROMPT,
  [MCP_TOOLS.REPORT]: EVENTS.TURN_END,
  [MCP_TOOLS.DISTILL]: EVENTS.AGENT_GENE,
  [MCP_TOOLS.STATUS]: EVENTS.COMMAND,
  [MCP_TOOLS.SEARCH]: EVENTS.COMMAND,
  [MCP_TOOLS.DRAFTS]: EVENTS.COMMAND,
  [MCP_TOOLS.LOGIN]: EVENTS.COMMAND,
  close: EVENTS.SESSION_END,
});

export const mcpPayload = Object.freeze({
  sessionId: (payload) => text(payload.session_id) || null,
  turnId: (payload) => text(payload.turn_id) || null,
  prompt: (payload) => text(payload.task),
  projectDir: (payload) => text(payload.project_dir) || null,
  isIgnored: () => false,
  model: () => null,
});

const OUTCOME_REASONS = { success: 'answer', failed: 'error', aborted: 'aborted' };

export const mcpTurnEnd = Object.freeze({
  reason: (payload) => OUTCOME_REASONS[payload.outcome] ?? 'answer',
  answer: (payload) => text(payload.summary),
  unclosed: Object.freeze({ settleMs: 0, as: 'error' }),
});

export const mcpEvidence = Object.freeze({
  source: AGENT_REPORTED,
  toolNote: () => null,
  editedFiles: () => [],
  turnRecord: (payload) => {
    const checks = list(payload.checks)
      .filter((check) => typeof check?.command === 'string' && check.command)
      .map((check) => ({ command: check.command.slice(0, 200), failed: check.exit !== 0 }));
    const files = list(payload.files).filter((file) => typeof file === 'string' && file);
    return { checks, commands: checks.map((check) => check.command), paths: files, edits: files, answer: '' };
  },
});

const asContent = (value, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError && { isError: true }) });

const turnLine = (payload) => `turn_id: ${payload.turn_id} (pass it to ${MCP_TOOLS.REPORT} when the task ends)`;
const EMPTY = {
  [MCP_TOOLS.REPORT]: 'Not reported: no task with this turn_id is open (a later recall closed it, or it was reported already).',
};

export const mcpReply = Object.freeze({
  context: (strategy, hostEvent, payload) => asContent(`${strategy || 'No stored strategy fits this task.'}\n\n${turnLine(payload)}`),
  notice: (notice) => asContent(notice ?? ''),
  empty: (hostEvent) => asContent(EMPTY[hostEvent] ?? ''),
  command: (result) => asContent(result.text, result.ok === false),
  turnEnd: (ended) => asContent(ended?.agentGene
    ? `Reported. This task qualifies for distillation: call ${MCP_TOOLS.DISTILL} with written_for ${ended.agentGene.writtenFor} and the JSON the request below asks for, or with {"skip": "<why>"} if it holds no method worth reusing.\n\n${ended.agentGene.prompt}`
    : 'Reported.'),
  lifetime: 'turn',
});

const COMMAND_TOOLS = new Set([MCP_TOOLS.STATUS, MCP_TOOLS.SEARCH, MCP_TOOLS.DRAFTS, MCP_TOOLS.LOGIN]);

export const mcpCommands = Object.freeze({
  entry: 'tool',
  parse: (payload, hostEvent) => (COMMAND_TOOLS.has(hostEvent)
    ? { name: hostEvent.replace(/^evolver_/, 'evolver-'), args: text(payload.args ?? payload.query ?? '') }
    : null),
});
