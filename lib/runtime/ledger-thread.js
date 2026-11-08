// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

import { loadReuseLedger, recordReuseLocally } from '../local-ledger.js';

const ROLE = 'evolver-reuse-ledger';

/**
 * The local ledger of a resident host: loading evolver-core holds an event loop for seconds, and a resident host shares
 * its loop with this plugin, so the ledger runs in a thread of its own (this file), which never keeps the process up.
 * A thread that stops rejects what it was asked, so a record it may have written is never written again.
 */
export function threadedLedger({ enginePrefix }) {
  let current = null;
  let nextId = 0;
  const started = () => {
    if (current) return current;
    // The host's own flags (a loader, `--input-type`) are its, not this thread's.
    const thread = new Worker(new URL(import.meta.url), { workerData: { role: ROLE, enginePrefix }, execArgv: [] });
    const waiting = new Map();
    const stopped = (error) => {
      for (const { reject } of waiting.values()) reject(error);
      waiting.clear();
      if (current?.thread === thread) current = null;
    };
    thread.on('message', ({ id, result, failed }) => {
      const pending = waiting.get(id);
      waiting.delete(id);
      if (failed) pending?.reject(new Error('the local ledger could not record'));
      else pending?.resolve(result);
    });
    thread.on('error', stopped);
    thread.on('exit', () => stopped(new Error('the local ledger thread stopped')));
    // After the listeners: attaching a message listener refs the thread again.
    thread.unref();
    current = { thread, waiting };
    return current;
  };
  const asked = (message) => new Promise((resolve, reject) => {
    const { thread, waiting } = started();
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    thread.postMessage({ id, ...message });
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
