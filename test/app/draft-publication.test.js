import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { hub } from '@evomap/evolver-core';

import { runCommand } from '../../lib/app/commands/index.js';
import { draftOf } from '../../lib/distill.js';
import { memoryPorts } from './memory-ports.js';

const GENE = { type: 'Gene', asset_id: 'sha256:gene' };
const CAPSULE = { type: 'Capsule', asset_id: 'sha256:capsule' };
const EVENT = { type: 'EvolutionEvent', asset_id: 'sha256:event' };
const RECEIPT = { version: 'publish-binding.v1', receiptId: 'proxy-issued-receipt' };
const RESULT = { ok: true, quality: { ok: true }, distill_id: 'draft-1', gene: GENE, capsule: CAPSULE };

async function withDraft(result) {
  const made = memoryPorts();
  const draft = draftOf(result, { title: 'Verified method', sessionId: 's1' }, made.ports.clock.now());
  await made.ports.drafts.update(() => [draft]);
  return { ...made, draft };
}

test('explicit publication preserves the Proxy receipt and its complete bound bundle', async () => {
  const { ports, requests } = await withDraft({ ...RESULT, publishable: true, publish_receipt: RECEIPT, event: EVENT });
  const publish = ports.proxy.request;
  ports.proxy.request = async (method, path, body) => {
    if (path === '/asset/submit') assert.deepEqual(body, {
      assets: [GENE, CAPSULE, EVENT], publish_receipt: RECEIPT,
      request_id: 'evolver-agent-plugin.draft.draft-1',
    });
    return publish(method, path, body);
  };
  assert.equal(requests.length, 0, 'keeping a draft does not submit it');
  const answer = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'publish 1' });
  assert.equal(answer.ok, true, answer.text);
  assert.equal(requests.length, 1);
  assert.deepEqual(await ports.drafts.read(), []);
});

test('a Proxy-declared unpublishable draft is retained and explains the trusted verification requirement', async () => {
  const { ports, requests, draft } = await withDraft({ ...RESULT, publishable: false });
  const answer = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'publish 1' });
  assert.equal(answer.ok, false);
  assert.match(answer.text, /trusted.*verif/i);
  assert.equal(requests.length, 0);
  assert.deepEqual(await ports.drafts.read(), [draft]);
  assert.equal((await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'discard 1' })).ok, true);
  assert.deepEqual(await ports.drafts.read(), []);
});

test('a rejected publication keeps the exact bound draft for review or retry', async () => {
  const { ports, draft } = await withDraft({ ...RESULT, publishable: true, publish_receipt: RECEIPT, event: EVENT });
  ports.proxy.request = async () => ({ ok: false, error: 'publish_binding_invalid' });
  const answer = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'publish 1' });
  assert.equal(answer.ok, false);
  assert.match(answer.text, /publish_binding_invalid/);
  assert.deepEqual(await ports.drafts.read(), [draft]);
});

test('the installed Core contract distinguishes HTTP claims from a trusted verifier receipt', async () => {
  const trace = [{ command: 'node --test retry.test.js', exit: 0 }];
  const input = {
    title: 'Bounded retry for transient HTTP failures',
    summary: 'When transient HTTP requests fail, retry only known retryable responses with bounded exponential backoff and jitter, then verify deterministic outcomes using an injected clock.',
    strategy: ['Classify transient failures before retrying.', 'Apply bounded exponential backoff with jitter.', 'Inject a clock and verify retry limits with a focused test.'],
    signals: ['HTTP timeout', 'retry limit'], validation: trace.map(row => row.command), execution: { trace },
    persist: false, publish: false,
  };
  const request = hub.createConversationVerificationRequest(input, input.validation, 'test-runtime', randomBytes(32).toString('hex'));
  const verifiedExecution = { trace, validation: input.validation, binding: { request, rootFingerprint: 'sha256:' + 'a'.repeat(64) } };
  for (const trusted of [false, true]) {
    const result = await hub.distillConversation(input, trusted ? { verifiedExecution, registerPublishReceipt: () => {} } : {});
    assert.equal(result.ok, true);
    assert.equal(result.publishable, trusted);
    const { ports, requests } = await withDraft(result);
    ports.proxy.request = async (method, path, body) => {
      requests.push({ method, path, body });
      hub.assertPublishBindingReceipt(body.assets, body.publish_receipt);
      return { ok: true, data: { message_id: 'fixture' } };
    };
    const answer = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'publish 1' });
    assert.equal(answer.ok, trusted, answer.text);
    assert.equal(requests.length, trusted ? 1 : 0);
    assert.equal((await ports.drafts.read()).length, trusted ? 0 : 1);
  }
});
