// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { engineNoticeOf } from './notice.js';
import { FAILURES } from './setup.js';
import { meetsMinimum } from './version.js';

// A setup outcome is written only when a setup runs, and none runs while a Proxy new enough answers, so a failure
// recorded before another host started that Proxy would otherwise be shown as current for good.
const CURED_BY_RUNNING_PROXY = new Set([...FAILURES, 'restart_needed', 'outdated']);

const isoOf = (at) => (Number.isFinite(at) ? new Date(at).toISOString() : null);

function recordedOf(outcome) {
  return { status: outcome.status, version: outcome.version ?? null, at: isoOf(outcome.at) };
}

function isCured(outcome, proxyVersion) {
  return outcome.source !== 'desktop' && CURED_BY_RUNNING_PROXY.has(outcome.status) && meetsMinimum(proxyVersion);
}

/** The engine setup as it stands now: the recorded outcome, or `ready` with it as `previous` once a running Proxy cured it. */
export function engineSetupOf(outcome, proxyVersion, hostLabel) {
  if (!outcome) return { status: 'not_run' };
  if (isCured(outcome, proxyVersion)) return { status: 'ready', previous: recordedOf(outcome) };
  const notice = engineNoticeOf(outcome, hostLabel);
  return { ...recordedOf(outcome), ...(notice && { notice }) };
}
