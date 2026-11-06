import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { events } from '@evomap/evolver-core';

import { recordReuseLocally } from '../lib/local-ledger.js';
import { withQueued } from '../lib/report-outbox.js';
import {
  correctionReportOf,
  deliverPending,
  deliveryOf,
  immediateReportOf,
  reportedReuseOf,
  retentionReportOf,
} from '../lib/reuse.js';

const ASSET = { assetId: 'sha256:a', strategyText: '' };
const NOW = 1_800_000_000_000;

function ledgers({ hub = { ok: true, data: {} }, local = true } = {}) {
  const posts = [];
  const locals = [];
  const rejections = [];
  return {
    posts,
    locals,
    proxyFetch: async (method, path, body) => {
      posts.push({ method, path, body });
      if (hub instanceof Error) throw hub;
      return hub;
    },
    rejections,
    onRejected: async (rejection) => { rejections.push(rejection); },
    recordLocally: async (request) => {
      locals.push(request);
      if (local instanceof Error) throw local;
      return local;
    },
  };
}

const immediate = (overrides = {}) => immediateReportOf({ asset: ASSET, sessionId: 'claude-code:s1', turn: 4, turnReason: 'answer', checks: [], applied: 'used', ...overrides });

test('a turn that ran no check still reports its injection, as tier none', () => {
  assert.deepEqual(immediate(), {
    asset_id: 'sha256:a',
    outcome: 'success',
    task_id: 'claude-code:s1:4',
    reason: 'Injected by Evolver into turn 4; applied: used; no check ran.',
    evidence: { tier: 'none', applied: 'used', source: 'observed', aborted: false, stage: 'immediate' },
  });
  assert.equal(immediate({ turnReason: 'error' }).outcome, 'failed');
});

test('a check the turn ran makes the report L1 and decides its outcome', () => {
  const passed = immediate({ checks: [{ command: 'npm test', failed: false }] });
  assert.equal(passed.outcome, 'success');
  assert.deepEqual(passed.evidence.check, { kind: 'test', passed: true, fail_then_pass: false });
  assert.equal(passed.evidence.tier, 'L1');

  const failed = immediate({ checks: [{ command: 'npx tsc -p .', failed: true }], applied: 'partial' });
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.evidence.check, { kind: 'typecheck', passed: false, fail_then_pass: false });
  assert.equal(failed.evidence.applied, 'partial');
});

test('the same check failing and then passing is recorded as such', () => {
  const report = immediate({
    checks: [{ command: 'npm test', failed: true }, { command: 'npm run lint', failed: false }, { command: 'npm test', failed: false }],
  });
  assert.deepEqual(report.evidence.check, { kind: 'test', passed: true, fail_then_pass: true });
  assert.match(report.reason, /last test passed after failing earlier/);
});

test('an interrupted turn says so', () => {
  const report = immediate({ turnReason: 'aborted' });
  assert.equal(report.evidence.aborted, true);
  assert.equal(report.outcome, 'failed');
});

test('a report reveals no command, prompt or code', () => {
  const report = immediate({ checks: [{ command: 'API_KEY=hunter22 npm test -- secret/path.js', exit: 0, failed: false }] });
  assert.doesNotMatch(JSON.stringify(report), /hunter22|secret\/path|npm test/);
});

test('a correction or approval follow-up is L3 under the turn task id plus :correction', () => {
  const reuse = reportedReuseOf(immediate());
  assert.deepEqual(correctionReportOf(reuse, 'correction'), {
    asset_id: 'sha256:a',
    outcome: 'failed',
    task_id: 'claude-code:s1:4:correction',
    reason: "The person's next prompt read as correction of the turn that reused this strategy.",
    evidence: { tier: 'L3', applied: 'used', stage: 'correction' },
  });
  assert.equal(correctionReportOf(reuse, 'praise').outcome, 'success');
  assert.equal(correctionReportOf(reuse, null), null);
});

test('kept or reverted edits are an L2 follow-up under :retention; anything else sends nothing', () => {
  const reuse = reportedReuseOf(immediate({ applied: 'partial' }));
  const kept = retentionReportOf(reuse, 'kept');
  assert.equal(kept.task_id, 'claude-code:s1:4:retention');
  assert.equal(kept.outcome, 'success');
  assert.deepEqual(kept.evidence, { tier: 'L2', applied: 'partial', stage: 'retention' });
  assert.equal(retentionReportOf(reuse, 'reverted').outcome, 'failed');
  assert.equal(retentionReportOf(reuse, 'rewritten'), null);
  assert.equal(retentionReportOf(reuse, 'no_change'), null);
});

test('queued reports go to the Hub until one is taken, then never again', async () => {
  const report = immediate({ checks: [{ command: 'npm test', failed: false }] });
  const down = ledgers({ hub: { ok: false, error: 'down' } });
  const outbox = withQueued({}, [{ report, sessionId: 'claude-code:s1' }], NOW);
  const retried = await deliverPending(down, outbox, NOW);
  assert.equal(down.posts[0].path, '/asset/reuse-result');
  assert.deepEqual(down.posts[0].body, report);
  assert.equal(Object.values(retried)[0].sentAt, undefined);

  const up = ledgers();
  const sent = await deliverPending(up, withQueued(retried, [{ report, sessionId: 'claude-code:s1' }], NOW + 1), NOW + 1);
  assert.equal(up.posts.length, 1);
  assert.equal(Object.values(sent)[0].sentAt, NOW + 1);

  const after = ledgers();
  await deliverPending(after, sent, NOW + 2);
  assert.equal(after.posts.length, 0);
});

test('a Proxy that answers without recording does not count as delivered', async () => {
  const sinks = ledgers({ hub: { ok: true, data: { recorded: false } } });
  const outbox = await deliverPending(sinks, withQueued({}, [{ report: immediate(), sessionId: 'claude-code:s1' }], NOW), NOW);
  assert.equal(Object.values(outbox)[0].sentAt, undefined);
  assert.equal(Object.values(outbox)[0].attempts, 1);
});

test('evidence-bearing reports are recorded locally once; tier none and a trial control never are, and a control goes to its own route', async () => {
  const sinks = ledgers({ hub: new Error('down') });
  const verified = immediate({ checks: [{ command: 'npm test', failed: true }] });
  const control = { report: { asset_id: 'sha256:a', task_id: 'claude-code:s1:3', passed: true, platform: 'claude-code' }, sessionId: 'claude-code:s1', path: '/asset/trial-control' };
  const outbox = withQueued({}, [{ report: verified, sessionId: 'claude-code:s1' }, { report: immediate({ turn: 5 }), sessionId: 'claude-code:s1' }, control], NOW);
  await deliverPending(sinks, await deliverPending(sinks, outbox, NOW), NOW);
  assert.deepEqual(sinks.locals, [{ assetId: 'sha256:a', outcome: 'failed', sessionId: 'claude-code:s1' }]);
  assert.deepEqual(sinks.posts.map(({ path }) => path), ['/asset/reuse-result', '/asset/reuse-result', '/asset/trial-control', '/asset/reuse-result', '/asset/reuse-result', '/asset/trial-control']);
  assert.deepEqual(sinks.posts[2].body, control.report);
});

test('a sent report retries a pre-write local failure without posting to the Hub again', async () => {
  const down = ledgers({ local: false });
  const queued = withQueued({}, [{ report: immediate({ checks: [{ command: 'npm test', failed: false }] }), sessionId: 'claude-code:s1' }], NOW);
  const sent = await deliverPending(down, queued, NOW);
  assert.equal(down.posts.length, 1);
  assert.equal(Object.values(sent)[0].sentAt, NOW);
  assert.equal(Object.values(sent)[0].localAt, undefined);
  const up = ledgers();
  const recorded = await deliverPending(up, sent, NOW + 1);
  assert.equal(up.posts.length, 0);
  assert.deepEqual(up.locals, [{ assetId: 'sha256:a', outcome: 'success', sessionId: 'claude-code:s1' }]);
  assert.equal(Object.values(recorded)[0].sentAt, NOW, 'the original Hub delivery time stays intact');
  assert.equal(Object.values(recorded)[0].localAt, NOW + 1);
  await deliverPending(up, recorded, NOW + 2);
  assert.equal(up.locals.length, 1);
  assert.equal(up.posts.length, 0);
});

test('a new report reaches the Hub before an earlier report retries its local record', async () => {
  const checks = [{ command: 'npm test', failed: false }];
  const earlier = await deliverPending(ledgers({ local: false }), withQueued({}, [{ report: immediate({ checks }), sessionId: 'claude-code:s1' }], NOW), NOW);
  const queued = withQueued(earlier, [{ report: immediate({ checks, sessionId: 'claude-code:s2' }), sessionId: 'claude-code:s2' }], NOW + 1);
  const order = [];
  const sinks = ledgers();
  await deliverPending({
    ...sinks,
    proxyFetch: (...request) => { order.push('hub'); return sinks.proxyFetch(...request); },
    recordLocally: (request) => { order.push(request.sessionId); return sinks.recordLocally(request); },
  }, queued, NOW + 1);
  assert.deepEqual(order, ['hub', 'claude-code:s2', 'claude-code:s1']);
});

function useTemporaryLedger(t) {
  const home = mkdtempSync(join(tmpdir(), 'evolver-ledger-retry-'));
  const previous = process.env.EVOLVER_HOME;
  process.env.EVOLVER_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.EVOLVER_HOME;
    else process.env.EVOLVER_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
}

test('a ledger lock timeout retries the local write after Hub delivery', async (t) => {
  useTemporaryLedger(t);
  let attempts = 0;
  t.mock.method(events.Ingestor.prototype, 'ingest', async () => {
    attempts += 1;
    if (attempts === 1) {
      throw Object.assign(new Error('ledger lock timeout'), { code: 'LOCK_TIMEOUT' });
    }
  });
  const sinks = { ...ledgers(), recordLocally: recordReuseLocally };
  const report = immediate({ checks: [{ command: 'npm test', failed: false }] });
  const queued = withQueued({}, [{ report, sessionId: 'claude-code:s1' }], NOW);
  const sent = await deliverPending(sinks, queued, NOW);
  const [pending] = Object.values(sent);
  assert.equal(pending.localFailures, 1);
  assert.equal(pending.localUncertainAt, undefined);
  assert.equal(pending.sentAt, NOW);

  const recorded = await deliverPending(sinks, sent, NOW + 1);
  assert.equal(Object.values(recorded)[0].localAt, NOW + 1);
  assert.equal(attempts, 2);
  assert.equal(sinks.posts.length, 1);
});

test('a ledger path blocked by a directory retries locally after the path is repaired', async (t) => {
  useTemporaryLedger(t);
  const path = events.rootEventsPath();
  mkdirSync(path, { recursive: true });

  const sinks = { ...ledgers(), recordLocally: recordReuseLocally };
  const report = immediate({ checks: [{ command: 'npm test', failed: false }] });
  const queued = withQueued({}, [{ report, sessionId: 'claude-code:s1' }], NOW);
  const sent = await deliverPending(sinks, queued, NOW);
  const [pending] = Object.values(sent);
  assert.equal(pending.sentAt, NOW);
  assert.equal(pending.localFailures, 1);
  assert.equal(pending.localUncertainAt, undefined);

  rmdirSync(path);
  const recorded = await deliverPending(sinks, sent, NOW + 1);
  assert.equal(Object.values(recorded)[0].localAt, NOW + 1);
  await deliverPending(sinks, recorded, NOW + 2);
  assert.equal(sinks.posts.length, 1);
  const entries = new events.Ingestor({ path }).readAllStrict();
  assert.deepEqual(entries.map(({ type, payload }) => ({ type, payload })), [
    { type: 'value.reuse_hit', payload: { assetId: ASSET.assetId, cycleId: 'claude-code:s1' } },
  ]);
});

test('an error after appending never retries either ledger', async (t) => {
  useTemporaryLedger(t);
  const ingest = events.Ingestor.prototype.ingest;
  const attempted = t.mock.method(events.Ingestor.prototype, 'ingest', async function (event) {
    await ingest.call(this, event);
    throw Object.assign(new Error('ledger failed after appending'), { code: 'EISDIR' });
  });
  const sinks = { ...ledgers(), recordLocally: recordReuseLocally };
  const report = immediate({ checks: [{ command: 'npm test', failed: false }] });
  let outbox = withQueued({}, [{ report, sessionId: 'claude-code:s1' }], NOW);
  for (let i = 0; i < 5; i += 1) outbox = await deliverPending(sinks, outbox, NOW + i);

  assert.equal(sinks.posts.length, 1);
  assert.equal(attempted.mock.callCount(), 1);
  assert.equal(new events.Ingestor({ path: events.rootEventsPath() }).readAllStrict().length, 1);
  assert.equal(Object.values(outbox)[0].sentAt, NOW);
  assert.equal(Object.values(outbox)[0].localUncertainAt, NOW);
  assert.equal(Object.values(outbox)[0].localAt, undefined);
});

test('exhausting local attempts does not stop Hub delivery retries', async () => {
  const down = ledgers({ hub: new Error('Hub offline'), local: false });
  const report = immediate({ checks: [{ command: 'npm test', failed: false }] });
  let outbox = withQueued({}, [{ report, sessionId: 'claude-code:s1' }], NOW);
  for (let i = 0; i < 4; i += 1) outbox = await deliverPending(down, outbox, NOW + i);

  assert.equal(down.posts.length, 4);
  assert.equal(down.locals.length, 3);
  const up = ledgers();
  const sent = await deliverPending(up, outbox, NOW + 4);
  assert.equal(up.posts.length, 1);
  assert.equal(up.locals.length, 0);
  assert.equal(Object.values(sent)[0].sentAt, NOW + 4);
});

test('a report the Hub already holds counts as delivered and is not retried', async () => {
  const sinks = ledgers({ hub: { ok: true, data: { recorded: false, reason: 'duplicate_report' } } });
  const outbox = await deliverPending(sinks, withQueued({}, [{ report: immediate(), sessionId: 'claude-code:s1' }], NOW), NOW);
  assert.equal(Object.values(outbox)[0].sentAt, NOW);
});

for (const reason of ['daily_cap', 'same_owner', 'no_delivery_proof']) {
  test(`a report the Hub judged ineligible (${reason}) is delivered and not retried`, async () => {
    const sinks = ledgers({ hub: { ok: true, data: { recorded: true, eligible: false, reason } } });
    const outbox = await deliverPending(sinks, withQueued({}, [{ report: immediate(), sessionId: 'claude-code:s1' }], NOW), NOW);
    assert.equal(Object.values(outbox)[0].sentAt, NOW);
    await deliverPending(sinks, outbox, NOW + 1);
    assert.equal(sinks.posts.length, 1);
  });
}

const queuedOne = (report) => withQueued({}, [{ report, sessionId: 'claude-code:s1' }], NOW);
const verified = () => immediate({ checks: [{ command: 'npm test', failed: false }] });

for (const data of [
  { recorded: false, terminal: true, reason: 'evidence.tier: Invalid input', status: 400 },
  { recorded: false, reason: 'hub 400' },
  { recorded: false, reason: 'hub 422: unprocessable' },
]) {
  test(`a report the Hub refuses (${data.reason}) is settled, logged and never written locally`, async () => {
    const sinks = ledgers({ hub: { ok: true, data } });
    const outbox = await deliverPending(sinks, queuedOne(verified()), NOW);
    const [entry] = Object.values(outbox);
    assert.equal(entry.rejectedAt, NOW);
    assert.equal(entry.sentAt, undefined);
    assert.equal(entry.rejection.reason, data.reason);
    assert.deepEqual(sinks.locals, []);
    assert.deepEqual(sinks.rejections.map(({ taskId, assetId, reason }) => ({ taskId, assetId, reason })), [
      { taskId: 'claude-code:s1:4', assetId: 'sha256:a', reason: data.reason },
    ]);

    await deliverPending(sinks, outbox, NOW + 1);
    assert.equal(sinks.posts.length, 1);
    assert.equal(sinks.rejections.length, 1);
  });
}

for (const hub of [
  { ok: true, data: { recorded: false, reason: 'hub 404' } },
  { ok: true, data: { recorded: false, reason: 'hub 500' } },
  { ok: true, data: { recorded: false, reason: 'hub 503' } },
  { ok: true, data: { recorded: false, reason: 'hub 429', status: 429 } },
  { ok: true, data: { recorded: false, reason: 'hub 401' } },
  { ok: false, error: 'timed out' },
  new Error('ECONNREFUSED'),
]) {
  test(`a failure that may pass later (${hub.data?.reason ?? hub.error ?? hub.message}) is retried`, async () => {
    const sinks = ledgers({ hub });
    const outbox = await deliverPending(sinks, queuedOne(verified()), NOW);
    assert.equal(Object.values(outbox)[0].rejectedAt, undefined);
    assert.equal(Object.values(outbox)[0].sentAt, undefined);
    await deliverPending(sinks, outbox, NOW + 1);
    assert.equal(sinks.posts.length, 2);
    assert.deepEqual(sinks.rejections, []);
  });
}

test('the status a newer Proxy passes through is kept with the rejection', () => {
  assert.deepEqual(deliveryOf({ ok: true, data: { recorded: false, terminal: true, reason: 'bad evidence', status: 400 } }), {
    verdict: 'rejected', reason: 'bad evidence', status: 400,
  });
  assert.deepEqual(deliveryOf({ ok: true, data: { recorded: true, eligible: false, reason: 'daily_cap' } }), { verdict: 'sent' });
});

test('a reuse that cannot be judged is exposure only, without the unused penalty', () => {
  const report = immediate({ applied: 'unknown' });
  assert.deepEqual(report.evidence, { tier: 'none', applied: 'partial', source: 'observed', aborted: false, stage: 'immediate' });
  assert.match(report.reason, /applied: unknown/);
  assert.equal(immediate({ applied: 'unknown', checks: [{ command: 'npm test', failed: false }] }).evidence.tier, 'none');
});
