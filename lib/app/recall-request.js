// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

export function recallRequestOf(proxy, { timeoutMs, hubTimeoutMs = timeoutMs } = {}) {
  // The Proxy accepts whole milliseconds in this range; preserve the caller's own wait below.
  const timeoutOnWire = Number.isFinite(hubTimeoutMs) && hubTimeoutMs > 0
    ? Math.min(30_000, Math.max(100, Math.ceil(hubTimeoutMs)))
    : undefined;
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
        const payload = timeoutOnWire === undefined ? body : { ...body, timeout_ms: timeoutOnWire };
        return await proxy.request(method, path, payload, { signal: request.signal, ...(timeoutMs > 0 ? { timeoutMs } : {}) });
      } finally {
        pending.delete(request);
      }
    },
  };
}
