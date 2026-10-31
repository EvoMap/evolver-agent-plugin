// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { recordReuseLocally } from '../local-ledger.js';
import { evolverCliOf } from './cli-executor.js';
import { commandJobsOf } from './command-jobs.js';
import { enginePortOf } from './engine/job.js';
import { hubSignInOf, signInFilesOf } from './hub-login.js';
import { detachedScheduler } from './lifetime/ephemeral.js';
import { inProcessScheduler } from './lifetime/resident.js';
import { modelRunnerOf } from './model-executor.js';
import { ownerProbeOf } from './process/owner.js';
import { proxyFetchOf, runningProxy } from './proxy.js';
import { settingsOf } from './settings.js';
import { recordReaderOf } from './records.js';
import { fileStoresOf } from './store/file-stores.js';

export const EPHEMERAL = 'ephemeral';
export const RESIDENT = 'resident';

const clock = Object.freeze({ now: () => Date.now(), sleep: (ms, signal) => new Promise(resolve => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
  if (signal?.aborted) done();
}) });

/**
 * Builds the ports for one agent in one execution environment: the only place execution differences are decided.
 * `lifetime` is EPHEMERAL for a process per hook event, RESIDENT for a plugin or server that stays up.
 * `runBackground(ports, tasks)` is the use case that background work runs; it is passed in so the runtime never
 * depends on the use cases. Returns the ports and `runTasks(tasks)`, which a worker process calls directly.
 */
export function environmentFor({ profile, env = process.env, lifetime, runBackground, overrides = {} }) {
  const stores = fileStoresOf({ dir: profile.stateDir(env), agent: profile.name });
  stores.adoptLegacy(profile.legacy);
  const request = proxyFetchOf(env, { closeConnection: lifetime === EPHEMERAL });
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
    modelRecord: recordReaderOf(profile.modelRecord, env),
    turnStatus: recordReaderOf(profile.turnEnd.statusRecord, env),
    owner: ownerProbeOf(profile.owner),
    clock,
    engine: enginePortOf(stores, { runningProxy: () => runningProxy({ env, proxyFetch: request }) }),
    ledger: { record: (entry) => recordReuseLocally(entry, { enginePrefix: stores.folder('engine') }) },
    cli: evolverCliOf({ enginePrefix: stores.folder('engine') }),
    signIn: hubSignInOf({ files: signInFilesOf(env), enginePrefix: stores.folder('engine'), env }),
    settings: settingsOf(env, profile.settingsFile?.(env)),
    ...overrides,
  };
  if (profile.commands.background) ports.commandJobs ??= commandJobsOf({ dir: stores.folder('commands'), agent: profile.name, env, accepts: profile.commands.background });
  const runTasks = async (tasks) => {
    stores.prune();
    return runBackground(ports, tasks);
  };
  ports.scheduler ??= lifetime === RESIDENT ? inProcessScheduler(runTasks) : detachedScheduler(profile.name, env);
  return { ports, runTasks };
}
