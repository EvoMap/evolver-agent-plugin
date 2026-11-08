// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

import { loadReuseLedger, recordReuseLocally } from '../local-ledger.js';

const ROLE = 'evolver-reuse-ledger';

/**
 * The local ledger of a resident host: loading evolver-core holds an event loop for seconds, and a resident host shares
 * its loop with this plugin, so the ledger runs in a thread of its own (this file), which never keeps the process up.
 */
export function threadedLedger({ enginePrefix }) {
  let thread = null;
  let nextId = 0;
  const waiting = new Map();
  const failAll = (error) => {
    for (const { reject } of waiting.values()) reject(error);
    waiting.clear();
    thread = null;
  };
  const started = () => {
    if (thread) return thread;
    // The host's own flags (a loader, `--input-type`) are its, not this thread's.
    thread = new Worker(new URL(import.meta.url), { workerData: { role: ROLE, enginePrefix }, execArgv: [] });
    thread.on('message', ({ id, result, failed }) => {
      const pending = waiting.get(id);
      waiting.delete(id);
      if (failed) pending?.reject(new Error('the local ledger could not record'));
      else pending?.resolve(result);
    });
    thread.on('error', failAll);
    thread.on('exit', () => failAll(new Error('the local ledger thread stopped')));
    // After the listeners: attaching a message listener refs the thread again.
    thread.unref();
    return thread;
  };
  const asked = (message) => new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    started().postMessage({ id, ...message });
  });
  return {
    load: async () => { await asked({ op: 'load' }); },
    record: (entry) => asked({ op: 'record', entry }),
  };
}

if (!isMainThread && workerData?.role === ROLE) {
  const { enginePrefix } = workerData;
  parentPort.on('message', async ({ id, op, entry }) => {
    try {
      const result = op === 'load' ? await loadReuseLedger({ enginePrefix }) : await recordReuseLocally(entry, { enginePrefix });
      parentPort.postMessage({ id, result });
    } catch {
      parentPort.postMessage({ id, failed: true });
    }
  });
}
