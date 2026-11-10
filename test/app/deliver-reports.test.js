import assert from 'node:assert/strict';
import { test } from 'node:test';

import { recordReports } from '../../lib/app/deliver-reports.js';
import { withQueued } from '../../lib/report-outbox.js';
import { immediateReportOf } from '../../lib/reuse.js';

const NOW = 1_800_000_000_000;

function portsHolding(outbox) {
  const records = [];
  let held = outbox;
  return {
    records,
    outbox: () => held,
    ports: {
      identity: { agent: 'codex', label: 'Codex' },
      proxy: { request: async () => ({ ok: true, data: { recorded: true } }) },
      ledger: { load: async () => {}, record: async (entry) => { records.push(entry); return true; } },
      outbox: {
        some: async (predicate) => Object.values(held).some(predicate),
        drain: async (deliver) => { held = await deliver(held, () => {}); return true; },
      },
      clock: { now: () => NOW },
    },
  };
}

test('a delivered report is recorded in the local ledger under the host that reused the asset', async () => {
  const report = immediateReportOf({ asset: { assetId: 'sha256:a' }, sessionId: 'codex:s1', turn: 2, turnReason: 'answer', checks: [{ command: 'npm test', failed: false }], applied: 'used' });
  const [[key, entry]] = Object.entries(withQueued({}, [{ report, sessionId: 's1' }], NOW));
  const held = portsHolding({ [key]: { ...entry, sentAt: NOW } });
  await recordReports(held.ports);
  assert.deepEqual(held.records, [{ assetId: 'sha256:a', outcome: 'success', sessionId: 's1', taskId: 'codex:s1:2', tier: 'L1', stage: 'immediate', platform: 'codex' }]);
  assert.equal(held.outbox()[key].localAt, NOW);
});
