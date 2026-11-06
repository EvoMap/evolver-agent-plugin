// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { hasUnknownChecks } from '../checks.js';
import { isCurrentCandidate, skipReason } from '../distill/candidate.js';
import { isCorrected, isSettling, sessionOf } from '../session/state.js';
import { turnEnded } from './turn-end.js';
import { scheduleDueDistillation } from './distill-session.js';
import { TASKS } from './ports.js';

const reasons = { completed: 'answer', failed: 'error', cancelled: 'aborted', interrupted: 'aborted' };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sameTurn = (left, right) => left.turn === right.turn && left.pid === right.pid && left.sessionEpoch === right.sessionEpoch;
const turnIdOf = value => typeof value === 'string' && value ? value : null;
const cursorOf = facts => ({ mark: facts.mark, schemaVersion: facts.schemaVersion, modelHint: facts.modelHint });

/** Optional observation of host records whose terminal can arrive after the last hook. */
export function turnObservationOf(ports, events = []) {
  const { native, sessions, owner, scheduler } = ports;
  if (!native) return null;
  return {
    scope: native.scope,
    observes: event => events.includes(event),
    recover: () => recoverNativeTurns(ports),
    async beforeEvent(at, payload, { prompt }) {
      const reconciled = await reconcileNativeTurn(ports, { ...at, payload });
      if (!prompt) return reconciled.facts;
      const cursor = (await sessions.read(at.sessionId)).nativeCursor;
      return readFacts(ports, payload, null, cursor);
    },
    async capturePrompt(at, payload, { nativeFacts: facts }) {
      let model = null;
      try { model = await ports.model?.capture?.(facts?.modelHint); } catch { /* No binding means no model request. */ }
      return async ({ turn, sessionEpoch }) => {
        const attached = await sessions.update(at.sessionId, stored => {
          if (!stored.open || stored.turn !== turn || stored.sessionEpoch !== sessionEpoch || stored.pid !== owner.current()) return undefined;
          return { ...stored, native: { turn, mark: facts?.status === 'ok' ? facts.mark : null, turnId: null, model,
            modelHint: facts?.modelHint ?? null, schemaVersion: facts?.schemaVersion ?? null, payload: native.reference(payload) } };
        });
        if (attached) scheduler.schedule([`${TASKS.NATIVE}:${JSON.stringify({ ...at, turn, sessionEpoch })}`]);
      };
    },
  };
}

async function activateCandidate(ports, sessionId, turn) {
  const { candidates, sessions } = ports;
  const expected = (await candidates.read())[sessionId];
  if (expected?.turn !== turn || expected.finalizationPending !== true || hasUnknownChecks(expected)) return;
  const session = sessionOf(await sessions.read(sessionId));
  const committed = session.native?.turn === turn && session.native.settled && !session.native.pending && session.native.candidateMade;
  if (session.sessionEpoch !== expected.sessionEpoch || isCorrected(session, turn) || !(committed || session.turn > turn)) return;
  let activated = false;
  await candidates.update(pending => {
    const candidate = pending[sessionId];
    if (!isCurrentCandidate(pending, sessionId, expected) || candidate.finalizationPending !== true || hasUnknownChecks(candidate)) return undefined;
    const { finalizationPending, ...ready } = candidate;
    activated = true;
    return { ...pending, [sessionId]: { ...ready, ...(session.native?.turn === turn && session.native.sessionEnded && { closed: true }) } };
  });
  if (activated) await scheduleDueDistillation(ports);
}

async function readFacts(ports, payload, native, cursor) {
  if (!ports.native?.read || !payload) return null;
  try {
    return await ports.native.read(payload, {
      after: native?.mark ?? cursor?.mark,
      turnId: native?.turnId ?? undefined,
      modelHint: native?.modelHint ?? cursor?.modelHint,
      schemaVersion: native?.schemaVersion ?? cursor?.schemaVersion,
    });
  } catch { return { status: 'unreadable' }; }
}

function capturedModel(native, terminal) {
  const captured = native.model, actual = terminal.modelHint;
  if (!captured || !actual || ['alias', 'model', 'protocol'].some(key => !actual[key] || captured[key] !== actual[key]) || (captured.effort ?? null) !== (actual.effort ?? null)) return null;
  // A changed current config cannot replace the verified turn's captured account. Keep that binding for a retry
  // after restoration; the runner checks it again before any native model request.
  return captured;
}

/** Reconcile only a previously opened logical turn with its matched native main-user identity and terminal. */
export async function reconcileNativeTurn(ports, at = {}, suppliedFacts) {
  const { sessionId, projectDir, payload, turn } = at;
  const stored = sessionOf(await ports.sessions.read(sessionId));
  if (Object.hasOwn(at, 'sessionEpoch') && at.sessionEpoch !== stored.sessionEpoch) return { facts: null, native: null, ended: null, waiting: false };
  const native = stored.native;
  const facts = suppliedFacts ?? await readFacts(ports, payload ?? native?.payload, native, stored.nativeCursor);
  const result = { facts, native: native ?? null, ended: null, waiting: Boolean(native && stored.turn === native.turn && (!native.settled || native.pending)) };
  if (!native || stored.turn !== native.turn || (turn !== undefined && turn !== native.turn)) return { ...result, waiting: false };
  if (facts?.status !== 'ok' || !facts.schemaSupported || facts.bind?.origin !== 'user') return result;
  const id = turnIdOf(facts.bind.turnId);
  if (!id || !Number.isSafeInteger(facts.bind.mark) || facts.bind.mark < native.mark?.offset
      || !facts.mark?.fileId || facts.mark.fileId !== native.mark?.fileId
      || (native.turnId != null && native.turnId !== id)
      || (native.promptId && native.promptId !== facts.bind.promptId)) return result;

  let bound = null;
  await ports.sessions.update(sessionId, currentStored => {
    const current = sessionOf(currentStored), state = current.native;
    if (!sameTurn(current, stored) || state?.turn !== native.turn || !same(state.payload, native.payload)
        || state.mark?.fileId !== native.mark.fileId || (state.turnId != null && state.turnId !== id)
        || (state.promptId && state.promptId !== facts.bind.promptId)) return undefined;
    bound = { ...current, ...(!current.open && !current.prompt && state.sessionEnded && { prompt: state.prompt || '' }), turnId: id, turnIds: [...current.turnIds.filter(known => known !== id), id].slice(-20), native: {
      ...state, turnId: id, promptId: facts.bind.promptId,
      schemaVersion: facts.schemaVersion, modelHint: facts.modelHint ?? state.modelHint,
    } };
    return bound;
  });
  if (!bound) return { ...result, waiting: false };
  result.native = bound.native;
  const terminal = facts.terminal;
  if (!terminal || terminal.turnId !== id || !reasons[terminal.reason] || !facts.record) return result;
  if (bound.native.settled && !bound.native.pending) {
    await activateCandidate(ports, sessionId, stored.turn);
    return { ...result, waiting: false };
  }
  const claimant = ports.owner.self();
  let claimed = null;
  await ports.sessions.update(sessionId, currentStored => {
    const current = sessionOf(currentStored), state = current.native;
    if (!Number.isSafeInteger(claimant) || claimant <= 0 || !sameTurn(current, stored)
        || state?.turnId !== id || state.promptId !== facts.bind.promptId || (state.settled && !state.pending)
        || (!current.open && isSettling(current, ports.clock.now()))
        || (state.finalizingPid && !ports.owner.isGone(state.finalizingPid))) return undefined;
    claimed = { ...current, native: { ...state, settled: false, finalizingPid: claimant } };
    return claimed;
  });
  if (!claimed) return result;
  try {
    const model = capturedModel(claimed.native, terminal);
    const pending = terminal.reason === 'completed' && hasUnknownChecks(facts.record);
    // Unknown results block verification, but only unfinished native calls need polling.
    const waiting = pending && facts.pendingVerification === true;
    const ended = await turnEnded(ports, {
      sessionId, projectDir: native.payload?.cwd ?? projectDir, turnId: id,
      expected: { turn: stored.turn, pid: stored.pid, sessionEpoch: stored.sessionEpoch },
      allowNewCandidate: !pending && !claimed.native.candidateMade,
      finalizationPending: true,
      reason: reasons[terminal.reason], answer: terminal.answer, model,
      recordOf: () => facts.record,
    });
    const eligible = !pending && skipReason(reasons[terminal.reason], { ...facts.record, answer: String(terminal.answer || facts.record.answer || '').trim() }) === null;
    await ports.sessions.update(sessionId, currentStored => {
      const current = sessionOf(currentStored);
      if (!sameTurn(current, stored) || current.native?.turnId !== id || current.native.finalizingPid !== claimant || current.open || isSettling(current, ports.clock.now())) return undefined;
      return { ...current, native: { ...current.native, settled: true, pending, candidateMade: Boolean(current.native.candidateMade || eligible) }, nativeCursor: cursorOf(facts) };
    });
    await activateCandidate(ports, sessionId, stored.turn);
    return { facts, native: claimed.native, ended, waiting };
  } finally {
    await ports.sessions.update(sessionId, currentStored => {
      const current = sessionOf(currentStored);
      if (!sameTurn(current, stored) || current.native?.turnId !== id || current.native.finalizingPid !== claimant) return undefined;
      return { ...current, native: { ...current.native, finalizingPid: null } };
    });
  }
}

/** Only inspect sessions already in the plugin's state; the native reader never discovers arbitrary history. */
export async function recoverNativeTurns(ports) {
  if (!ports.native?.read) return [];
  const pending = await ports.candidates.read();
  const known = [];
  let scanError;
  try {
    await ports.sessions.updateEach((stored, sessionId) => {
      if ((stored?.native && stored.turn === stored.native.turn) || pending[sessionId]?.finalizationPending) known.push({ sessionId, turn: stored.turn, sessionEpoch: stored.sessionEpoch });
    });
  } catch (error) { scanError = error; }
  const results = [];
  for (const at of known) {
    results.push(await reconcileNativeTurn(ports, at));
    if (pending[at.sessionId]?.finalizationPending) await activateCandidate(ports, at.sessionId, pending[at.sessionId].turn);
  }
  if (scanError) throw scanError;
  return results;
}
