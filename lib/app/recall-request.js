// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

export function recallRequestOf(proxy) {
  const controller = new AbortController();
  const { signal } = controller;
  const pending = new Set();
  return {
    signal,
    cancel() {
      controller.abort();
      for (const request of pending) request.abort();
    },
    async request(method, path, body) {
      if (signal.aborted) return { ok: false };
      const request = new AbortController();
      pending.add(request);
      try {
        return await proxy.request(method, path, body, { signal: request.signal });
      } finally {
        pending.delete(request);
      }
    },
  };
}
