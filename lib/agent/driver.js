// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { distillText } from '../app/commands/distill.js';
import { runCommand } from '../app/commands/index.js';
import { distillSession, postAgentGene } from '../app/distill-session.js';
import { openTurnOf, promptSubmitted } from '../app/prompt.js';
import { sessionEnded } from '../app/session-end.js';
import { isNewOwner, sessionStarted } from '../app/session-start.js';
import { beforeEdit, toolFinished } from '../app/tool-result.js';
import { closeUnfinishedTurn, turnEnded } from '../app/turn-end.js';
import { waitBudgetOf } from '../runtime/budget.js';
import { EVENTS } from './events.js';

// The one place a host's event becomes a use case: the profile reads the payload and shapes the answer, the use
// cases do the work over the ports. Whatever fails answers the profile's empty reply, never an error to the host.

const joined = (...texts) => texts.filter(Boolean).join('\n\n');

const HANDLERS = {
  async [EVENTS.SESSION_START]({ profile, ports, hostEvent, at }) {
    const notice = await sessionStarted(ports, { sessionId: at.sessionId, projectDir: at.projectDir });
    return notice ? profile.reply.notice(notice, hostEvent) : profile.reply.empty(hostEvent);
  },

  async [EVENTS.PROMPT]({ profile, ports, hostEvent, payload, context, at, waitMs }) {
    const { sessionId, projectDir } = at;
    const prompt = profile.payload.prompt(payload, context);
    const isNewSession = profile.sessionStart === 'owner-change' && (await isNewOwner(ports, sessionId));
    const notice = isNewSession ? await sessionStarted(ports, { sessionId, projectDir }) : null;
    const typed = profile.commands.parse(payload, hostEvent, { prompt });
    if (typed && profile.commands.entry === 'intercept') return profile.reply.command(await runCommand(ports, { sessionId, ...typed }), hostEvent);
    const turnId = profile.payload.turnId(payload, context);
    const open = profile.reply.lifetime === 'call' ? await openTurnOf(ports, sessionId) : null;
    if (open && turnId && open.turnId === turnId) return profile.reply.context(joined(notice, open.strategy), hostEvent);
    await closeUnfinishedTurn(ports, { sessionId, projectDir, ...profile.turnEnd.unclosed });
    const turnStart = profile.evidence.turnStart?.(payload, context) ?? null;
    const { injection } = await promptSubmitted(ports, { sessionId, prompt, turnId, turnStart, isCommand: Boolean(typed), waitMs });
    return profile.reply.context(joined(notice, injection), hostEvent);
  },

  async [EVENTS.TOOL_RESULT]({ profile, ports, hostEvent, payload, context, at }) {
    const note = profile.evidence.toolNote(payload, context);
    if (note) await toolFinished(ports, { sessionId: at.sessionId, note });
    return profile.reply.empty(hostEvent);
  },

  async [EVENTS.BEFORE_EDIT]({ profile, ports, hostEvent, payload, context, at }) {
    const file = profile.evidence.editedFile(payload, context);
    if (file) await beforeEdit(ports, { sessionId: at.sessionId, file });
    return profile.reply.empty(hostEvent);
  },

  async [EVENTS.TURN_END]({ profile, ports, hostEvent, payload, context, at }) {
    const reason = profile.turnEnd.reason(payload, context);
    if (reason === 'unknown') return profile.reply.empty(hostEvent);
    const recordOf = profile.evidence.turnRecord && ((opened) => profile.evidence.turnRecord(payload, { ...context, turnStart: opened.turnStart }));
    const ended = await turnEnded(ports, {
      sessionId: at.sessionId,
      turnId: profile.payload.turnId(payload, context),
      reason,
      answer: profile.turnEnd.answer(payload, context),
      model: profile.payload.model(payload, context),
      projectDir: at.projectDir,
      recordOf,
      source: profile.evidence.source,
    });
    if (!ended) return profile.reply.empty(hostEvent);
    const agentGene = profile.model?.kind === 'in-session' ? (await distillSession(ports, { sessionId: at.sessionId })).agentGene : undefined;
    return profile.reply.turnEnd({ ...ended, agentGene }, hostEvent);
  },

  async [EVENTS.SESSION_END]({ profile, ports, hostEvent, at }) {
    await sessionEnded(ports, { sessionId: at.sessionId, projectDir: at.projectDir });
    return profile.reply.empty(hostEvent);
  },

  async [EVENTS.COMMAND]({ profile, ports, hostEvent, payload, context, at }) {
    const typed = profile.commands.parse(payload, hostEvent, { prompt: profile.payload.prompt(payload, context) });
    if (!typed) return profile.reply.empty(hostEvent);
    return profile.reply.command(await runCommand(ports, { sessionId: at.sessionId, ...typed }), hostEvent);
  },

  async [EVENTS.AGENT_GENE]({ profile, ports, hostEvent, payload, context, at }) {
    const gene = profile.payload.gene(payload, context);
    const text = typeof gene === 'string' ? gene : JSON.stringify(gene ?? null);
    const outcome = await postAgentGene(ports, { sessionId: at.sessionId, text, writtenFor: profile.payload.writtenFor(payload, context) });
    return profile.reply.command(distillText(outcome), hostEvent);
  },
};

/**
 * A driver for one agent over its ports. `transcripts` reads a host's transcript for the profile, so the agent's
 * own code stays free of IO; `lifetime` and `startedAt` size how long a prompt may wait for recall.
 */
export function createDriver({ profile, ports, transcripts, lifetime, startedAt = Date.now() }) {
  const contextOf = (payload) => {
    const file = profile.payload.transcriptPath(payload);
    return { transcriptSize: () => transcripts.size(file), transcriptSince: (offset) => transcripts.readSince(file, offset) };
  };
  return {
    async handle(hostEvent, payload = {}) {
      try {
        const event = profile.events[hostEvent];
        const context = contextOf(payload);
        if (!event || profile.payload.isSubagent(payload, context)) return profile.reply.empty(hostEvent);
        const sessionId = profile.payload.sessionId(payload, context);
        if (!sessionId) return profile.reply.empty(hostEvent);
        const at = { sessionId, projectDir: profile.payload.projectDir(payload, context) };
        const waitMs = waitBudgetOf(profile.budgets, 'prompt', { lifetime, startedAt });
        return await HANDLERS[event]({ profile, ports, hostEvent, payload, context, at, waitMs });
      } catch {
        return profile.reply.empty(hostEvent);
      }
    },
  };
}
