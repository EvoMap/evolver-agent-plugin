// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { EVENTS } from '../../agent/events.js';
import { promptTextOf, recallStrategy, taskTextOf } from '../../recall.js';
import { waitBudgetOf } from '../../runtime/budget.js';
import { clientOf } from '../../runtime/client.js';
import { EPHEMERAL } from '../../runtime/environment.js';
import { ownerIsGone, ownerProbeOf } from '../../runtime/process/owner.js';
import { proxyFetchOf } from '../../runtime/proxy.js';
import { settingsOf } from '../../runtime/settings.js';
import { fileStoresOf } from '../../runtime/store/file-stores.js';

const hashOf = (text) => createHash('sha256').update(text).digest('hex');

/** A request-only host stages context without entering the report or candidate lifecycle. */
export async function recallOnlyReply({ profile, hostEvent, payload, env, startedAt }) {
  const context = { env, hostEvent };
  const empty = () => profile.reply.empty(hostEvent, payload);
  if (!Object.hasOwn(profile.events, hostEvent) || profile.payload.isIgnored(payload, context)) return empty();
  const event = profile.events[hostEvent];
  const sessionId = profile.payload.sessionId(payload, context);
  const at = Date.parse(payload.timestamp);
  if (!sessionId || !Number.isFinite(at)) return empty();

  const owner = ownerProbeOf(profile.owner, { windowsAncestry: profile.windowsAncestry }).current();
  if (!owner) return empty();
  const stores = fileStoresOf({ dir: profile.stateDir(env), agent: profile.name });
  const { sessions } = stores;
  const locked = (work) => sessions.withSession(sessionId, work);
  const update = (mutate) => locked(() => sessions.update(sessionId, mutate));

  if (event === EVENTS.SESSION_START) {
    await update((current) => {
      // The TUI can dispatch its initial prompt before the startup hook finishes.
      if (current.owner === owner && !current.closed && current.awaitingStart) {
        return { ...current, awaitingStart: false };
      }
      return at > (current.at ?? 0) ? { owner, at } : undefined;
    });
    stores.prune();
    return empty();
  }

  const matches = (current) => current.owner === owner && !current.closed && at >= current.at;
  if (event === EVENTS.SESSION_END) {
    await update((current) => (matches(current) ? { owner, at, closed: true } : undefined));
    return empty();
  }

  const enabled = settingsOf(env, profile.settingsFile?.(env)).recall;
  if (hostEvent !== profile.recallOnly.requestEvent) {
    const prompt = enabled && profile.payload.prompt(payload, context);
    const opened = (awaitingStart) => ({ owner, at, promptOpened: true, awaitingStart, ...(prompt && { promptHash: hashOf(prompt) }) });
    await update((current) => {
      if (!current.owner || (current.owner !== owner && at > current.at && (current.closed || ownerIsGone(current.owner)))) {
        return opened(true);
      }
      if (!matches(current) || (current.promptOpened && at === current.at)) return undefined;
      return opened(current.awaitingStart);
    });
    return empty();
  }

  const request = enabled && profile.recallOnly.requestOf(payload);
  if (!request?.prompt) return empty();
  const promptHash = hashOf(request.prompt);
  const requestHash = hashOf(JSON.stringify(request.history));
  const replyFor = (recipe) => recipe ? profile.reply.context(recipe, hostEvent, payload) : empty();
  // Bind the first matching request before searching, so a prompt that never reaches the model cannot leave a Recipe.
  const admission = await locked(async () => {
    const current = await sessions.read(sessionId);
    if (!matches(current) || current.promptHash !== promptHash) return null;
    if (current.requestHash) return { reply: replyFor(current.requestHash === requestHash && current.recipe) };
    const saved = await sessions.update(sessionId, (stored) => ({ ...stored, requestHash }));
    return saved ? { openedAt: current.at } : null;
  });
  if (!admission) return empty();
  if (admission.reply) return admission.reply;

  const task = taskTextOf(request.prompt);
  const waitMs = waitBudgetOf(profile.budgets, 'prompt', { lifetime: EPHEMERAL, startedAt });
  const client = clientOf({ agent: profile.name, releaseFile: stores.agentRelease });
  const fetchProxy = proxyFetchOf(env, { closeConnection: true, clientHeaders: client.headers });
  const deadline = AbortSignal.timeout(Math.ceil(waitMs));
  const finished = new AbortController();
  const signal = AbortSignal.any([deadline, finished.signal]);
  const recipeCutoff = delay(Math.max(0, waitMs - 300), null, { ref: false, signal }).catch(() => null);
  const match = await recallStrategy((method, path, body) => fetchProxy(method, path, body, { signal }), promptTextOf(request.prompt), {
    context: task ? { task, trigger: 'turn_start' } : null,
    projectDir: profile.payload.projectDir(payload, context),
    closingOf: () => 'Apply it where it fits.',
    recipeCutoff,
  }).finally(() => finished.abort());
  if (!match.text || deadline.aborted) return empty();
  const saved = await update((current) => (matches(current) && current.at === admission.openedAt && current.requestHash === requestHash
    ? { ...current, recipe: match.text }
    : undefined));
  return saved ? replyFor(match.text) : empty();
}
