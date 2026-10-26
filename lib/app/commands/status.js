// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withoutDraft } from '../../distill.js';
import { engineNoticeOf } from '../../engine/notice.js';
import { MIN_EVOLVER_VERSION } from '../../engine/version.js';
import { proxyStatusText } from '../../proxy-status.js';
import { success } from './result.js';

function engineLine(outcome, label) {
  if (!outcome) return `Required Evolver: ${MIN_EVOLVER_VERSION} or newer; no engine setup has run yet.`;
  const notice = engineNoticeOf(outcome, label);
  return `Required Evolver: ${MIN_EVOLVER_VERSION} or newer. Engine setup: ${outcome.status}${outcome.version ? ` (${outcome.version})` : ''}.${notice ? `\n${notice}` : ''}`;
}

export default {
  name: 'evolver-status',
  description: 'Evolver health: the Proxy, engine setup, distillation candidate and drafts.',
  async run({ identity, proxy, engine, candidates, drafts, clock }, { sessionId }) {
    const answered = await proxy.request('GET', '/proxy/status', undefined, { timeoutMs: 3_000 });
    const waiting = withoutDraft(await drafts.read(), null, clock.now()).length;
    return success([
      answered.ok ? proxyStatusText(answered.data) : answered.error,
      engineLine(await engine.outcome(), identity.label),
      (await candidates.read())[sessionId] ? 'This session has a verified turn waiting to be distilled.' : 'No distillation candidate in this session.',
      `${waiting} distilled draft(s) waiting; /evolver-drafts lists them.`,
    ].join('\n'));
  },
};
