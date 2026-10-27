// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { turnSummaryOf } from '../../lib/turn-summary.js';

const STRATEGY_NAME = /^\[Evolution Memory\] (.+?) \(EvoMap network\):/;

const nameOf = (strategy) => STRATEGY_NAME.exec(String(strategy ?? ''))?.[1] ?? 'EvoMap strategy';

/** The one line Claude Code shows under a turn that reused a strategy, or null for any other turn. */
export function summaryLineOf({ record, strategies }, usage) {
  return turnSummaryOf({ reusedNames: (strategies ?? []).map(nameOf), lastCheck: record?.checks?.at(-1), changedLines: 0, usage });
}
