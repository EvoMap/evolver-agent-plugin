// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { verdictOf } from './checks.js';
import { turnTaskId } from './reuse.js';

// The Proxy holds a trial Gene back from a share of the turns it would fit, so its effect can be measured against
// turns that went without it. A withheld turn reports how its last check ended, as the turns that got it do.

export const TRIAL_CONTROL_PATH = '/asset/trial-control';

/**
 * The outbox entries of a turn's withheld trial Genes (`{ asset_id, withheld_id }`), one per asset, each under the
 * withholding it answers: none when the turn ran no check with a known result, or when a later recall of the turn
 * injected the Gene after all, since then it is no control.
 */
export function trialControlEntriesOf({ platform, taskSessionId, sessionId, turn, withheld, injectedIds, checks }) {
  const verdict = verdictOf(checks?.at(-1));
  if (verdict === 'unknown') return [];
  const firstPerAsset = withheld.filter((entry, index) => withheld.findIndex((other) => other.asset_id === entry.asset_id) === index);
  return firstPerAsset.filter((entry) => !injectedIds.has(entry.asset_id)).map(({ asset_id: assetId, withheld_id: withheldId }) => ({
    report: { asset_id: assetId, withheld_id: withheldId, task_id: turnTaskId(taskSessionId, turn), passed: verdict === 'passed', platform },
    sessionId,
    path: TRIAL_CONTROL_PATH,
  }));
}
