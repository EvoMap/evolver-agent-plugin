// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { deliverPending, isLocalRecordDue, postPending } from '../reuse.js';

const ledgersOf = ({ proxy, ledger }) => ({
  proxyFetch: (method, path, body) => proxy.request(method, path, body),
  recordLocally: (entry) => ledger.record(entry),
  onRejected: async () => {},
});

/** Posts the queued reuse reports to the Hub, retrying the unsettled ones; one process at a time holds the outbox. */
export function deliverReports(ports) {
  return ports.outbox.drain((due, afterAttempt) => postPending(ledgersOf(ports), due, ports.clock.now(), afterAttempt));
}

/** Records the delivered reports in the local ledger, whose evolver-core loads, when one is due, before the outbox is taken. */
export async function recordReports(ports) {
  if (!(await ports.outbox.some(isLocalRecordDue))) return true;
  await ports.ledger.load();
  return ports.outbox.drain((due, afterAttempt) => deliverPending(ledgersOf(ports), due, ports.clock.now(), afterAttempt));
}
