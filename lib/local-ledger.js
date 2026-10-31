// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcess } from './runtime/process/spawn.js';

const HIT_EVENT = 'value.reuse_hit';
const OUTCOME_EVENT = 'value.reuse_outcome';
const MAX_TITLE_CHARS = 80;

// Keyed by path, not a single instance: the log lives under the home directory,
// and a process that sees a different one must not keep writing to the first.
const byPath = new Map();

const NPM_ROOT_TIMEOUT_MS = 5_000;

async function globalNpmRoot() {
  const result = await runProcess('npm', ['root', '-g'], { timeoutMs: NPM_ROOT_TIMEOUT_MS, shim: true });
  return result.error || result.code !== 0 ? null : result.stdout.trim() || null;
}

// A plugin installed from a marketplace has no node_modules of its own. The
// evolver CLI that runs the Proxy ships evolver-core, and a reuse report only
// exists once that Proxy answered a recall, so the CLI's copy is the fallback:
// one a plugin installed under its own prefix first, then the global one.
function importFromCli(prefix) {
  const fromCli = createRequire(join(prefix, '@evomap', 'evolver', 'package.json'));
  return import(pathToFileURL(fromCli.resolve('@evomap/evolver-core')).href);
}

async function importEvolverCore(enginePrefix) {
  try {
    return await import('@evomap/evolver-core');
  } catch {
  }
  if (enginePrefix) {
    try {
      return await importFromCli(join(enginePrefix, 'node_modules'));
    } catch {
    }
  }
  const npmRoot = await globalNpmRoot();
  if (!npmRoot) throw new Error('evolver-core not found');
  return importFromCli(npmRoot);
}

function loadIngestor(enginePrefix) {
  return importEvolverCore(enginePrefix)
    .then(({ events }) => {
      const path = events.rootEventsPath();
      let ingestor = byPath.get(path);
      if (!ingestor) {
        ingestor = new events.Ingestor({ path });
        byPath.set(path, ingestor);
      }
      return ingestor;
    })
    .catch(() => null);
}

function cycleIdOf(sessionId) {
  return sessionId || 'unknown';
}

// The verdict has to become a root_event to be worth anything: the actuator
// that re-orders candidates reads root_events, not the Hub, and a Hub without
// the route records nothing at all. Success and the negative verdicts ride
// different events by design -- the ledger derives savings from one and the
// keep/prune signal from the other.
export async function recordReuseLocally({ assetId, outcome, sessionId }, { enginePrefix } = {}) {
  if (!assetId || !outcome) return false;
  const ingestor = await loadIngestor(enginePrefix);
  if (!ingestor) return false;

  const cycleId = cycleIdOf(sessionId);
  const success = outcome === 'success';
  try {
    await ingestor.ingest({
      type: success ? HIT_EVENT : OUTCOME_EVENT,
      human: {
        title: `Evolver reuse ${outcome}`.slice(0, MAX_TITLE_CHARS),
        detail: `cycle ${cycleId}`,
      },
      payload: success ? { assetId, cycleId } : { assetId, cycleId, outcome },
    });
    return true;
  } catch {
    return false;
  }
}
