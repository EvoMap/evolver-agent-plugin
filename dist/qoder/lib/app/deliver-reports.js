// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { deliverPending } from '../reuse.js';

/** Delivers the queued reuse reports, retrying the unsettled ones; one process at a time holds the outbox. */
export function deliverReports({ outbox, proxy, ledger, clock }) {
  const ledgers = {
    proxyFetch: (method, path, body) => proxy.request(method, path, body),
    recordLocally: (entry) => ledger.record(entry),
    onRejected: async () => {},
  };
  return outbox.drain((due, afterAttempt) => deliverPending(ledgers, due, clock.now(), afterAttempt));
}
