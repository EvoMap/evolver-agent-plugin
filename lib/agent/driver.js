// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { distillText } from '../app/commands/distill.js';
import { commandNamed, runCommand } from '../app/commands/index.js';
import { distillSession, postAgentGene } from '../app/distill-session.js';
import { adoptStrategy, lastTurnOf, promptSubmitted, takeWaitingStrategy } from '../app/prompt.js';
import { sessionEnded } from '../app/session-end.js';
import { isNewOwner, sessionStarted } from '../app/session-start.js';
import { beforeEdit, toolFinished } from '../app/tool-result.js';
import { closeUnfinishedTurn, turnEnded } from '../app/turn-end.js';
import { waitBudgetOf } from '../runtime/budget.js';
import { EVENTS, STRATEGY_AT } from './events.js';

// The one place a host's event becomes a use case: the profile reads the payload and shapes the answer, the use
// cases do the work over the ports. Whatever fails answers the profile's empty reply, never an error to the host.

const joined = (...texts) => texts.filter(Boolean).join('\n\n');

const recordReaderOf = (profile, payload, context) =>
  profile.evidence.turnRecord && ((opened) => profile.evidence.turnRecord(payload, { ...context, turnStart: opened.turnStart }));

/**
 * The turn this prompt repeats, if any: the same turn id as the last turn's (a host submitting a generation again),
 * or, where an injection lasts one model call, any call that names no turn. Its strategy is replayed only where an
 * injection lasts one call; elsewhere the conversation already holds it.
 */
async function repeatedTurnOf(profile, ports, sessionId, turnId) {
  const isPerCall = profile.reply.lifetime === 'call';
  if (!turnId && !isPerCall) return null;
  const last = await lastTurnOf(ports, sessionId);
  const isRepeat = turnId ? last?.turnId === turnId : true;
  return isRepeat ? { strategy: isPerCall ? last?.strategy ?? '' : '' } : null;
}

// A command run outside any session (from a terminal) has no conversation whose model would see its strategy.
async function commandAnswer(profile, ports, at, typed, options = {}) {
  const result = await runCommand(ports, { ...at, ...typed, signal: options.signal });
  const reachesSessionModel = profile.commands.answerReachesModel && !at.anySession;
  if (result.strategy && reachesSessionModel) await adoptStrategy(ports, { sessionId: at.sessionId, strategy: result.strategy });
  return result;
}

const HANDLERS = {
  async [EVENTS.SESSION_START]({ profile, ports, hostEvent, payload, at }) {
    const notice = await sessionStarted(ports, { sessionId: at.sessionId, projectDir: at.projectDir });
    return notice ? profile.reply.notice(notice, hostEvent, payload) : profile.reply.empty(hostEvent, payload);
  },

  async [EVENTS.PROMPT]({ profile, ports, hostEvent, payload, context, at, waitLeft }) {
    const { sessionId, projectDir } = at;
    const prompt = profile.payload.prompt(payload, context);
    const isNewSession = profile.sessionStart === 'owner-change' && (await isNewOwner(ports, sessionId));
    const notice = isNewSession ? await sessionStarted(ports, { sessionId, projectDir }) : null;
    const typed = profile.commands.parse(payload, hostEvent, { prompt });
    const isIntercepted = Boolean(typed) && profile.commands.entry === 'intercept';
    const isForAgent = Boolean(typed && commandNamed(typed.name)?.forAgent);
    if (isIntercepted && !isForAgent) return profile.reply.command(await commandAnswer(profile, ports, at, typed), hostEvent, payload);
    // Where the host shows the agent only the typed command, the command's prompt rides this turn's context, also when
    // it is typed while a turn runs.
    const checkpointOf = async () => (isIntercepted && isForAgent ? (await commandAnswer(profile, ports, at, typed)).text : '');
    const turnId = profile.payload.turnId(payload, context);
    const repeated = await repeatedTurnOf(profile, ports, sessionId, turnId);
    if (repeated) return profile.reply.context(joined(notice, await checkpointOf(), repeated.strategy), hostEvent, payload);
    await closeUnfinishedTurn(ports, { sessionId, projectDir, recordOf: recordReaderOf(profile, payload, context), ...profile.turnEnd.unclosed });
    const turnStart = profile.evidence.turnStart?.(payload, context) ?? null;
    const keepLate = typeof profile.reply.late === 'function';
    const hostTurn = profile.payload.hostTurn(payload, context);
    const holdForToolResult = profile.reply.strategyAt === STRATEGY_AT.TOOL_RESULT;
    const { injection, late } = await promptSubmitted(ports, { sessionId, prompt, turnId, turnStart, hostTurn, isCommand: Boolean(typed), waitMs: waitLeft(), keepLate, holdForToolResult });
    const answer = profile.reply.context(joined(notice, await checkpointOf(), injection), hostEvent, payload);
    return late ? profile.reply.late(answer, late, hostEvent, payload) : answer;
  },

  async [EVENTS.TOOL_RESULT]({ profile, ports, hostEvent, payload, context, at }) {
    const note = profile.evidence.toolNote(payload, context);
    const turnId = profile.payload.turnId(payload, context);
    if (note) await toolFinished(ports, { sessionId: at.sessionId, turnId, note });
    const strategy = await takeWaitingStrategy(ports, { sessionId: at.sessionId, turnId });
    return strategy ? profile.reply.context(strategy, hostEvent, payload) : profile.reply.empty(hostEvent, payload);
  },

  async [EVENTS.BEFORE_EDIT]({ profile, ports, hostEvent, payload, context, at }) {
    const turnId = profile.payload.turnId(payload, context);
    for (const file of profile.evidence.editedFiles(payload, context)) await beforeEdit(ports, { sessionId: at.sessionId, turnId, file });
    return profile.reply.empty(hostEvent, payload);
  },

  async [EVENTS.TURN_END]({ profile, ports, hostEvent, payload, context, at }) {
    const reason = profile.turnEnd.reason(payload, context);
    if (reason === 'unknown') return profile.reply.empty(hostEvent, payload);
    const recordOf = recordReaderOf(profile, payload, context);
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
    if (!ended) return profile.reply.empty(hostEvent, payload);
    const asksForGene = profile.model?.kind === 'in-session' && ended.isCandidate;
    const agentGene = asksForGene ? (await distillSession(ports, { sessionId: at.sessionId })).agentGene : undefined;
    return profile.reply.turnEnd({ ...ended, agentGene }, hostEvent, payload);
  },

  async [EVENTS.SESSION_END]({ profile, ports, hostEvent, payload, context, at }) {
    const turnId = profile.payload.turnId(payload, context);
    await sessionEnded(ports, { sessionId: at.sessionId, projectDir: at.projectDir, turnId, settleMs: profile.turnEnd.unclosed?.settleMs ?? 0 });
    return profile.reply.empty(hostEvent, payload);
  },

  async [EVENTS.COMMAND]({ profile, ports, hostEvent, payload, context, at, options }) {
    const typed = profile.commands.parse(payload, hostEvent, { prompt: profile.payload.prompt(payload, context) });
    if (!typed) return profile.reply.empty(hostEvent, payload);
    return profile.reply.command(await commandAnswer(profile, ports, at, typed, options), hostEvent, payload);
  },

  async [EVENTS.AGENT_GENE]({ profile, ports, hostEvent, payload, context, at }) {
    const outcome = await geneOutcome(ports, at, { gene: profile.payload.gene(payload, context), writtenFor: profile.payload.writtenFor(payload, context) });
    return profile.reply.command(distillText(outcome), hostEvent, payload);
  },
};

function geneOutcome(ports, at, { gene, writtenFor }) {
  const text = typeof gene === 'string' ? gene : JSON.stringify(gene ?? null);
  return postAgentGene(ports, { sessionId: at.sessionId, text, writtenFor, anySession: at.anySession });
}

/**
 * A driver for one agent over its ports. `transcripts` reads a host's transcript for the profile, so the agent's
 * own code stays free of IO, and `env` is the environment the host gave this event, which some hosts use to say
 * what the payload does not; `lifetime` and `startedAt` size how long a prompt may still wait for recall once the
 * last turn is settled and a session started, so the hook answers within the host's timeout.
 */
export function createDriver({ profile, ports, transcripts, env = process.env, lifetime, startedAt = Date.now() }) {
  const contextOf = (payload, hostEvent) => {
    const file = profile.payload.transcriptPath(payload);
    return { env, hostEvent, transcriptSize: () => transcripts.size(file), transcriptSince: (offset) => transcripts.readSince(file, offset) };
  };
  return {
    /**
     * For a channel that reads its own input rather than a host payload (a command script): runs `command`
     * (`{ name, args }`) or posts `gene` for the candidate stamped `writtenFor`, in `at` (`{ sessionId, projectDir,
     * anySession }`; `anySession` lets a command with no session of its own act on the latest candidate). Answers
     * the use case's `{ ok, text, … }`; a failure is an answer too.
     */
    async direct(at, { command, gene, writtenFor }) {
      try {
        if (command) return await commandAnswer(profile, ports, at, command);
        return distillText(await geneOutcome(ports, at, { gene, writtenFor }));
      } catch (error) {
        return { ok: false, text: `Evolver failed: ${String(error?.message ?? error)}` };
      }
    },
    async handle(hostEvent, payload = {}, options = {}) {
      try {
        const event = profile.events[hostEvent];
        const context = contextOf(payload, hostEvent);
        if (!event || profile.payload.isIgnored(payload, context)) return profile.reply.empty(hostEvent, payload);
        const sessionId = profile.payload.sessionId(payload, context);
        if (!sessionId) return profile.reply.empty(hostEvent, payload);
        const at = { sessionId, projectDir: profile.payload.projectDir(payload, context) };
        const waitLeft = () => waitBudgetOf(profile.budgets, 'prompt', { lifetime, startedAt });
        return await HANDLERS[event]({ profile, ports, hostEvent, payload, context, at, waitLeft, options });
      } catch {
        return profile.reply.empty(hostEvent, payload);
      }
    },
  };
}
