// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { isCorrected, isSettling, sessionOf } from '../session/state.js';
import { skipReason } from '../distill/candidate.js';
import { turnEnded } from './turn-end.js';

const reasons = { completed: 'answer', failed: 'error', cancelled: 'aborted', interrupted: 'aborted' };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const turnIdOf = value => typeof value === 'string' && value ? value : null;
const cursorOf = facts => ({ mark: facts.mark, schemaVersion: facts.schemaVersion, modelHint: facts.modelHint });
const waitingOn = record => record?.checks?.some(check => check.failed === null) ?? false;

async function activateCandidate({ candidates, sessions }, sessionId, turn) {
  const expected = (await candidates.read())[sessionId];
  if (expected?.turn !== turn || expected.finalizationPending !== true) return;
  const session = sessionOf(await sessions.read(sessionId));
  const committed = session.native?.turn === turn && session.native.settled && session.native.candidateMade;
  if (isCorrected(session, turn) || !(committed || session.turn > turn)) return;
  await candidates.update(pending => {
    const candidate = pending[sessionId];
    if (candidate?.turn !== turn || candidate.at !== expected.at || candidate.finalizationPending !== true) return undefined;
    const { finalizationPending, ...ready } = candidate;
    return { ...pending, [sessionId]: { ...ready, ...(session.native?.turn === turn && session.native.sessionEnded && { closed: true }) } };
  });
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
export async function reconcileNativeTurn(ports, { sessionId, projectDir, payload, turn } = {}, suppliedFacts) {
  const stored = sessionOf(await ports.sessions.read(sessionId));
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
    if (current.turn !== stored.turn || current.pid !== stored.pid || state?.turn !== native.turn || !same(state.payload, native.payload)
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
    if (!Number.isSafeInteger(claimant) || claimant <= 0 || current.turn !== stored.turn || current.pid !== stored.pid
        || state?.turnId !== id || state.promptId !== facts.bind.promptId || (state.settled && !state.pending)
        || (!current.open && isSettling(current, ports.clock.now()))
        || (state.finalizingPid && !ports.owner.isGone(state.finalizingPid))) return undefined;
    claimed = { ...current, native: { ...state, settled: false, finalizingPid: claimant } };
    return claimed;
  });
  if (!claimed) return result;
  try {
    const model = capturedModel(claimed.native, terminal);
    const ended = await turnEnded(ports, {
      sessionId, projectDir: projectDir ?? native.payload?.cwd, turnId: id,
      expectedTurn: stored.turn, expectedPid: stored.pid,
      allowNewCandidate: !claimed.native.candidateMade,
      finalizationPending: true,
      reason: reasons[terminal.reason], answer: terminal.answer, model,
      recordOf: () => facts.record,
    });
    const pending = terminal.reason === 'completed' && waitingOn(facts.record);
    const eligible = skipReason(reasons[terminal.reason], { ...facts.record, answer: String(terminal.answer || facts.record.answer || '').trim() }) === null;
    await ports.sessions.update(sessionId, currentStored => {
      const current = sessionOf(currentStored);
      if (current.turn !== stored.turn || current.pid !== stored.pid || current.native?.turnId !== id || current.native.finalizingPid !== claimant || current.open || isSettling(current, ports.clock.now())) return undefined;
      return { ...current, native: { ...current.native, settled: true, pending, candidateMade: Boolean(current.native.candidateMade || eligible) }, nativeCursor: cursorOf(facts) };
    });
    await activateCandidate(ports, sessionId, stored.turn);
    return { facts, native: claimed.native, ended, waiting: pending };
  } finally {
    await ports.sessions.update(sessionId, currentStored => {
      const current = sessionOf(currentStored);
      if (current.turn !== stored.turn || current.pid !== stored.pid || current.native?.turnId !== id || current.native.finalizingPid !== claimant) return undefined;
      return { ...current, native: { ...current.native, finalizingPid: null } };
    });
  }
}

/** Only inspect sessions already in the plugin's state; the native reader never discovers arbitrary history. */
export async function recoverNativeTurns(ports) {
  if (!ports.native?.read) return [];
  const pending = await ports.candidates.read();
  const known = [];
  await ports.sessions.updateEach((stored, sessionId) => {
    if ((stored?.native && stored.turn === stored.native.turn) || pending[sessionId]?.finalizationPending) known.push({ sessionId, projectDir: stored.native?.payload?.cwd, turn: stored.turn });
  });
  const results = [];
  for (const at of known) {
    results.push(await reconcileNativeTurn(ports, at));
    if (pending[at.sessionId]?.finalizationPending) await activateCandidate(ports, at.sessionId, pending[at.sessionId].turn);
  }
  return results;
}
