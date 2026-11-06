// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { IR_VERSION } from './ir-prompt.js';
import { DIFF_OMITTED } from './project-diff.js';
import { PROXY_BODY_MAX_BYTES } from './record.js';

const bytesOf = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

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
 * rides the first only, since one call wrote them all.
 */
export function distillBodiesOf({ platform, sessionId, trigger, session, irs, usage = null, persist = true }) {
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
    persist,
    publish: false,
    ...(usage && index === 0 && { distill_usage: usage }),
  }));
}
