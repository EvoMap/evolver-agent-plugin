// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { randomUUID } from 'node:crypto';

/**
 * A ModelRunner whose completions the host's module runs: `port.complete(model, prompt, signal)` queues a request
 * and resolves `{ answer, usage }` once the module posts it back. The module pulls requests with `next(waitMs)`, a
 * long poll that resolves null when none came, and answers each with `answer({ id, text, usage, error })`.
 */
export function createModelQueue() {
  const queued = [];
  const takers = [];
  const pending = new Map();

  const offer = (request) => {
    const taker = takers.shift();
    if (taker) taker(request);
    else queued.push(request);
  };

  const port = {
    complete: (model, prompt, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const request = { id: randomUUID(), model, prompt };
      const abandon = () => {
        pending.delete(request.id);
        const at = queued.indexOf(request);
        if (at >= 0) queued.splice(at, 1);
        reject(signal.reason);
      };
      signal?.addEventListener('abort', abandon, { once: true });
      pending.set(request.id, (outcome) => {
        signal?.removeEventListener('abort', abandon);
        pending.delete(request.id);
        if (outcome.error) reject(new Error(outcome.error));
        else resolve({ answer: String(outcome.text ?? ''), usage: outcome.usage ?? null });
      });
      offer(request);
    }),
  };

  const next = (waitMs) => {
    if (queued.length > 0) return Promise.resolve(queued.shift());
    return new Promise((resolve) => {
      const taker = (request) => {
        clearTimeout(timer);
        resolve(request);
      };
      const timer = setTimeout(() => {
        takers.splice(takers.indexOf(taker), 1);
        resolve(null);
      }, waitMs);
      takers.push(taker);
    });
  };

  const answer = ({ id, text, usage, error }) => {
    const settle = pending.get(id);
    settle?.({ text, usage, error });
    return Boolean(settle);
  };

  return { port, next, answer };
}
