// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { recordReuseLocally } from '../local-ledger.js';
import { evolverCliOf } from './cli-executor.js';
import { enginePortOf } from './engine/job.js';
import { detachedScheduler } from './lifetime/ephemeral.js';
import { inProcessScheduler } from './lifetime/resident.js';
import { modelRunnerOf } from './model-executor.js';
import { ownerProbeOf } from './process/owner.js';
import { proxyFetchOf, runningProxy } from './proxy.js';
import { fileStoresOf } from './store/file-stores.js';

export const EPHEMERAL = 'ephemeral';
export const RESIDENT = 'resident';

const clock = Object.freeze({ now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });

/**
 * Builds the ports for one agent in one execution environment: the only place execution differences are decided.
 * `lifetime` is EPHEMERAL for a process per hook event, RESIDENT for a plugin or server that stays up.
 * `runBackground(ports, tasks)` is the use case that background work runs; it is passed in so the runtime never
 * depends on the use cases. Returns the ports and `runTasks(tasks)`, which a worker process calls directly.
 */
export function environmentFor({ profile, env = process.env, lifetime, runBackground, overrides = {} }) {
  const stores = fileStoresOf({ dir: profile.stateDir(env), agent: profile.name });
  const request = proxyFetchOf(env);
  const ports = {
    identity: { agent: profile.name, label: profile.label },
    sessions: stores.sessions,
    notes: stores.notes,
    baseline: stores.baseline,
    candidates: stores.candidates,
    drafts: stores.drafts,
    reports: stores.reports,
    outbox: stores.outbox,
    retention: stores.retention,
    proxy: { request },
    model: modelRunnerOf(profile.model, env),
    owner: ownerProbeOf(lifetime === RESIDENT ? 'self' : profile.owner),
    clock,
    engine: enginePortOf(stores, { runningProxy: () => runningProxy({ env, proxyFetch: request }) }),
    ledger: { record: (entry) => recordReuseLocally(entry, { enginePrefix: stores.folder('engine') }) },
    cli: evolverCliOf(),
    ...overrides,
  };
  const runTasks = async (tasks) => {
    if (tasks.includes('engine')) stores.prune();
    return runBackground(ports, tasks);
  };
  ports.scheduler ??= lifetime === RESIDENT ? inProcessScheduler(runTasks) : detachedScheduler(profile.name, env);
  return { ports, runTasks };
}
