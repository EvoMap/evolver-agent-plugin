// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { IR_VERSION } from './ir-prompt.js';
import { DIFF_OMITTED } from './project-diff.js';
import { PROXY_BODY_MAX_BYTES } from './record.js';

const bytesOf = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

const ASSET_ID = /^sha256:[0-9a-f]{64}$/;
const MAX_REUSED_ASSET_IDS = 20;

/**
 * The assets the session's injection ledger booked into the turns `range` covers, in the order they were injected, at
 * most 20, for the Proxy to record what the distilled work reused. A turn of another session epoch (a session file
 * started over) is another turn, whatever its number.
 */
export function reusedAssetIdsOf({ injected = {}, sessionEpoch }, range) {
  const epochOf = (turn) => turn.sessionEpoch ?? range.sessionEpoch;
  const isSessionTurn = (turn) => sessionEpoch === undefined || epochOf(turn) === undefined || epochOf(turn) === sessionEpoch;
  const turns = new Set(range.turns.filter(isSessionTurn).map(({ turn }) => turn));
  return Object.entries(injected)
    .filter(([assetId, entry]) => ASSET_ID.test(assetId) && turns.has(entry?.turn))
    .sort(([, left], [, right]) => left.turn - right.turn || (left.injectedAt ?? 0) - (right.injectedAt ?? 0))
    .slice(0, MAX_REUSED_ASSET_IDS)
    .map(([assetId]) => assetId);
}

// The record is fitted before the model reads it; an IR long enough to push the body over still gets through by
// losing the diff, then the diff lines, which come last so no other line's number changes.
function withinBodyLimit(body) {
  if (bytesOf(body) <= PROXY_BODY_MAX_BYTES) return body;
  const withoutDiff = typeof body.project?.diff === 'string' ? { ...body, project: { diff_omitted: DIFF_OMITTED.TOO_LARGE } } : body;
  if (bytesOf(withoutDiff) <= PROXY_BODY_MAX_BYTES) return withoutDiff;
  return { ...withoutDiff, record: withoutDiff.record.filter((line) => line.kind !== 'diff') };
}

/**
 * One `POST /conversation/distill` body per IR, all on the same record (see lib/distill/record.js). The model's usage
 * rides the first only, since one call wrote them all. `reusedAssetIds` rides every one; a Proxy that does not know
 * the field ignores it, as it ignores any field it does not read.
 */
export function distillBodiesOf({ platform, sessionId, trigger, session, irs, usage = null, persist = true, reusedAssetIds = [] }) {
  return irs.map((ir, index) => withinBodyLimit({
    platform,
    session_id: sessionId,
    trigger,
    ir_version: IR_VERSION,
    ir,
    record: session.record,
    user_prompt: session.userPrompt,
    final_answer: session.finalAnswer,
    execution: { trace: session.trace },
    ...(session.project && { project: session.project }),
    ...(session.projectDir && { project_dir: session.projectDir }),
    ...(reusedAssetIds.length > 0 && { reused_asset_ids: reusedAssetIds }),
    persist,
    publish: false,
    ...(usage && index === 0 && { distill_usage: usage }),
  }));
}
