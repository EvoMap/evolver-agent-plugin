import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hub } from '@evomap/evolver-core';

import { runCommand } from '../../lib/app/commands/index.js';
import { promptSubmitted } from '../../lib/app/prompt.js';
import { sessionEnded } from '../../lib/app/session-end.js';
import { draftOf } from '../../lib/distill.js';
import { proxyFetchOf } from '../../lib/runtime/proxy.js';
import { fileStoresOf } from '../../lib/runtime/store/file-stores.js';
import { fakeProxy } from '../helpers/fake-proxy.js';
import { lockContenders, until } from '../helpers/lock-contenders.js';
import { memoryPorts } from './memory-ports.js';

const GENE = { type: 'Gene', asset_id: 'sha256:gene' };
const CAPSULE = { type: 'Capsule', asset_id: 'sha256:capsule' };
const EVENT = { type: 'EvolutionEvent', asset_id: 'sha256:event' };
const RECEIPT = {
  version: 'publish-binding.v1', receiptId: 'proxy-issued-receipt', bundleDigest: 'bundle', inputDigest: 'input',
  validationDigest: 'validation', runtimeDigest: 'runtime', rootFingerprint: 'root', executionDigest: 'execution',
};
const RESULT = { ok: true, quality: { ok: true }, distill_id: 'draft-1', gene: GENE, capsule: CAPSULE };

async function withDraft(result) {
  const made = memoryPorts();
  const draft = draftOf(result, { title: 'Verified method', sessionId: 's1' }, made.ports.clock.now());
  await made.ports.drafts.update(() => [draft]);
  return { ...made, draft };
}

for (const publishable of [false, true]) {
  test(`a correction blocks a lingering ${publishable ? 'verified' : 'local-only'} draft after cleanup fails`, async () => {
    const { ports, requests, draft } = await withDraft({ ...RESULT, publishable, ...(publishable && { publish_receipt: RECEIPT }) });
    const corrected = { ...draft, sourceCandidate: { turn: 2, at: 20 } };
    const earlier = { ...draft, id: 'earlier', publishable: true, publish_receipt: RECEIPT, sourceCandidate: { turn: 1, at: 10 } };
    await ports.sessions.update('s1', () => ({ turn: 2 }));
    await ports.drafts.update(() => [corrected, earlier]);
    const updateDrafts = ports.drafts.update;
    ports.drafts.update = async () => { throw new Error('draft cleanup denied'); };
    await assert.rejects(promptSubmitted(ports, { sessionId: 's1', prompt: 'still failing', waitMs: 0 }), /draft cleanup denied/);
    ports.drafts.update = updateDrafts;
    await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });

    const publish = (args) => runCommand(ports, { sessionId: 'another-session', name: 'evolver-drafts', args });
    const result = await publish('publish 1');
    assert.equal(result.ok, false);
    assert.match(result.text, /invalidated by a correction/i);
    assert.deepEqual(requests, []);
    assert.deepEqual(await ports.drafts.read(), [corrected, earlier]);
    assert.equal((await publish('publish 2')).ok, true);
    assert.deepEqual(requests.map(({ path }) => path), ['/asset/submit']);
    assert.equal((await publish('discard 1')).ok, true);
    assert.deepEqual(await ports.drafts.read(), []);
  });
}

test('a correction during reverification blocks submit even if it cannot remove the draft', async () => {
  const { ports, requests, draft } = await withDraft({ ...RESULT, publishable: false });
  const source = { ...draft, sourceCandidate: { turn: 1, at: 10 } };
  await ports.sessions.update('s1', () => ({ turn: 1 }));
  await ports.drafts.update(() => [source]);
  const updateDrafts = ports.drafts.update;
  ports.proxy.request = async (method, path, body) => {
    requests.push({ method, path, body });
    if (path !== '/asset/reverify') return { ok: true };
    ports.drafts.update = async () => { throw new Error('draft cleanup denied'); };
    try {
      await assert.rejects(promptSubmitted(ports, { sessionId: 's1', prompt: 'still failing', waitMs: 0 }), /draft cleanup denied/);
    } finally {
      ports.drafts.update = updateDrafts;
    }
    return { ok: true, data: { ok: true, publishable: true, assets: [GENE, CAPSULE], publish_receipt: RECEIPT } };
  };

  const result = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'publish 1' });
  assert.equal(result.ok, false);
  assert.match(result.text, /invalidated by a correction/i);
  assert.deepEqual(requests.map(({ path }) => path), ['/asset/reverify']);
  assert.deepEqual(await ports.drafts.read(), [source]);
});

test('a correction after the publication check cannot slip into submit dispatch', async (t) => {
  const { ports, draft } = await withDraft({ ...RESULT, publishable: true, publish_receipt: RECEIPT });
  const proxy = await fakeProxy();
  t.after(proxy.close);
  ports.proxy.request = proxyFetchOf(proxy.env);
  ports.draftCorrections = fileStoresOf({ dir: proxy.env.HOME, agent: 'testagent' }).draftCorrections;
  const correctionPorts = { ...ports, draftCorrections: fileStoresOf({ dir: proxy.env.HOME, agent: 'testagent' }).draftCorrections };
  const source = { ...draft, sourceCandidate: { turn: 1, at: 10 } };
  await ports.sessions.update('s1', () => ({ turn: 1 }));
  await ports.drafts.update(() => [source]);
  const hasCorrection = ports.draftCorrections.has;
  const updateDrafts = ports.drafts.update;
  let checked = false;
  ports.draftCorrections.has = async (...args) => {
    const observed = await hasCorrection(...args);
    if (!checked) {
      checked = true;
      ports.drafts.update = async () => { throw new Error('draft cleanup denied'); };
      try {
        await assert.rejects(promptSubmitted(correctionPorts, { sessionId: 's1', prompt: 'still failing', waitMs: 0 }), /draft cleanup denied/);
      } finally {
        ports.drafts.update = updateDrafts;
      }
    }
    return observed;
  };

  const result = await runCommand(ports, { sessionId: 'another-session', name: 'evolver-drafts', args: 'publish 1' });
  assert.equal(checked, true);
  assert.deepEqual(proxy.requests, []);
  assert.equal(result.ok, false);
  assert.match(result.text, /invalidated by a correction/i);
  assert.deepEqual(await ports.drafts.read(), [source]);
});

test('a correction can finish while a dispatched submit waits for the Proxy reply', async (t) => {
  const { ports, draft } = await withDraft({ ...RESULT, publishable: true, publish_receipt: RECEIPT });
  const proxy = await fakeProxy();
  t.after(proxy.close);
  ports.proxy.request = proxyFetchOf(proxy.env);
  ports.draftCorrections = fileStoresOf({ dir: proxy.env.HOME, agent: 'testagent' }).draftCorrections;
  const correctionPorts = { ...ports, settings: { recall: false }, draftCorrections: fileStoresOf({ dir: proxy.env.HOME, agent: 'testagent' }).draftCorrections };
  await ports.sessions.update('s1', () => ({ turn: 1 }));
  await ports.drafts.update(() => [{ ...draft, sourceCandidate: { turn: 1, at: 10 } }]);

  const dispatched = Promise.withResolvers();
  const reply = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', (url) => {
    dispatched.resolve(new URL(url).pathname);
    return reply.promise;
  });
  const publishing = runCommand(ports, { sessionId: 'another-session', name: 'evolver-drafts', args: 'publish 1' });
  try {
    assert.equal(await dispatched.promise, '/asset/submit');
    await promptSubmitted(correctionPorts, { sessionId: 's1', prompt: 'still failing', waitMs: 0 });
    assert.equal(await correctionPorts.draftCorrections.has('s1', 1), true);
    assert.deepEqual(await ports.drafts.read(), []);
  } finally {
    reply.resolve(new Response('{"message_id":"fixture-submit"}'));
    assert.equal((await publishing).ok, true);
  }
});

test('two dead-owner recoverers cannot dispatch a draft after correction', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-draft-recovery-'));
  const state = fileStoresOf({ dir, agent: 'testagent' });
  const url = (path) => JSON.stringify(new URL(path, import.meta.url).href);
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { join } from 'node:path';
    import { runCommand } from ${url('../../lib/app/commands/index.js')};
    import { promptSubmitted } from ${url('../../lib/app/prompt.js')};
    import { proxyFetchOf } from ${url('../../lib/runtime/proxy.js')};
    import { fileStoresOf } from ${url('../../lib/runtime/store/file-stores.js')};
    import { memoryPorts } from ${url('./memory-ports.js')};
    import { until } from ${url('../helpers/lock-contenders.js')};
    const [dir, lock, role] = process.argv.slice(1);
    const marker = (name) => join(dir, name);
    const { sessions, drafts, draftCorrections } = fileStoresOf({ dir, agent: 'testagent' });
    const { ports } = memoryPorts();
    Object.assign(ports, { sessions, drafts, draftCorrections, settings: { recall: false } });
    if (role === 'correction') {
      const stat = fs.statSync;
      fs.statSync = (file, ...args) => {
        const snapshot = stat(file, ...args);
        if (file === lock) {
          fs.statSync = stat;
          fs.writeFileSync(marker('stale-read'), '');
          const deadline = Date.now() + 10_000;
          while (!fs.existsSync(marker('resume'))) {
            if (Date.now() >= deadline) throw new Error('timed out resuming correction');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        return snapshot;
      };
      ports.drafts.update = async () => { throw new Error('draft cleanup denied'); };
      await assert.rejects(promptSubmitted(ports, { sessionId: 's1', prompt: 'still failing', waitMs: 0 }), /draft cleanup denied/);
      fs.writeFileSync(marker('corrected'), '');
    } else {
      const { has, withSession } = draftCorrections;
      let inGate = false;
      draftCorrections.has = async (...args) => {
        const corrected = await has(...args);
        if (inGate && !corrected) await until(() => fs.existsSync(marker('corrected')));
        return corrected;
      };
      draftCorrections.withSession = (id, work, signal) => {
        const result = withSession(id, () => {
          inGate = true;
          return work();
        }, signal);
        fs.writeFileSync(marker('publish-attempted'), '');
        return result;
      };
      globalThis.fetch = async (url) => {
        assert.equal(new URL(url).pathname, '/asset/submit');
        fs.writeFileSync(marker('submitted'), '');
        return new Response('{}');
      };
      ports.proxy.request = proxyFetchOf({ HOME: dir });
      const result = await runCommand(ports, { sessionId: 'another-session', name: 'evolver-drafts', args: 'publish 1' });
      fs.writeFileSync(marker('result'), JSON.stringify(result));
    }
  `;
  const lockName = createHash('sha256').update('s1').digest('hex').slice(0, 16);
  const lock = join(dir, 'testagent-distill-corrections', `${lockName}.lock`);
  const { run, results } = lockContenders(t, dir, script, [dir, lock], ['resume', 'corrected']);
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(dead.status, 0);
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner'), `${dead.pid}:deadbeef`);
  utimesSync(lock, new Date(0), new Date(0));
  await state.sessions.update('s1', () => ({ turn: 1 }));
  const draft = { ...draftOf({ ...RESULT, publishable: true, publish_receipt: RECEIPT }, { title: 'Verified method', sessionId: 's1' }, 100), sourceCandidate: { turn: 1, at: 10 } };
  await state.drafts.update(() => [draft]);

  run('correction');
  await until(() => existsSync(join(dir, 'stale-read')));
  run('publish');
  await until(() => existsSync(join(dir, 'publish-attempted')));
  writeFileSync(join(dir, 'resume'), '');
  const outcomes = await results();
  assert.ok(outcomes.every(({ code }) => code === 0), JSON.stringify(outcomes));
  assert.equal(await state.draftCorrections.has('s1', 1), true);
  assert.equal(existsSync(join(dir, 'submitted')), false);
  const result = JSON.parse(readFileSync(join(dir, 'result'), 'utf8'));
  assert.equal(result.ok, false);
  assert.match(result.text, /invalidated by a correction/i);
  assert.deepEqual(await state.drafts.read(), [draft]);
});

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
  ports.proxy.request = async (method, path, body) => {
    requests.push({ method, path, body });
    return { ok: false, error: 'publish_reverification_unavailable' };
  };
  const answer = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'publish 1' });
  assert.equal(answer.ok, false);
  assert.match(answer.text, /trusted.*verif/i);
  assert.deepEqual(requests.map(({ path }) => path), ['/asset/reverify']);
  assert.deepEqual(await ports.drafts.read(), [draft]);
  assert.equal((await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'discard 1' })).ok, true);
  assert.deepEqual(await ports.drafts.read(), []);
});

test('explicit publication reverifies a draft and retains the promoted bundle when submission fails', async () => {
  const { ports, requests } = await withDraft({ ...RESULT, publishable: false });
  const cancellation = new AbortController();
  ports.proxy.request = async (method, path, body, options) => {
    requests.push({ method, path, body, options });
    assert.equal(options.signal, cancellation.signal);
    if (path === '/asset/reverify') {
      assert.deepEqual(body, { assets: [GENE, CAPSULE], persist: false });
      assert.equal(options.timeoutMs, 120_000);
      return { ok: true, data: { ok: true, publishable: true, assets: [GENE, CAPSULE, EVENT], publish_receipt: RECEIPT } };
    }
    assert.deepEqual(body.assets, [GENE, CAPSULE, EVENT]);
    assert.deepEqual(body.publish_receipt, RECEIPT);
    assert.deepEqual((await ports.drafts.read())[0].assets, body.assets, 'the retry bundle is saved before submission');
    return { ok: false, error: 'Hub unavailable' };
  };
  const answer = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'publish 1', signal: cancellation.signal });
  assert.equal(answer.ok, false);
  assert.deepEqual(requests.map(({ path }) => path), ['/asset/reverify', '/asset/submit']);
  assert.equal((await ports.drafts.read())[0].publishable, true);
  requests.length = 0;
  ports.proxy.request = async (method, path, body) => { requests.push({ path, body }); return { ok: true, data: {} }; };
  assert.equal((await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'publish 1' })).ok, true);
  assert.deepEqual(requests.map(({ path }) => path), ['/asset/submit']);
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

test('a legacy draft without publication metadata forwards a newer Proxy receipt unchanged', async () => {
  const { ports, requests } = await withDraft(RESULT);
  const receipt = { version: 'publish-binding.v2', opaque: 'proxy-issued' };
  ports.proxy.request = async (method, path, body) => {
    requests.push({ method, path, body });
    if (path === '/asset/reverify') {
      await ports.drafts.update((list) => list.map((draft) => Object.fromEntries(Object.entries(draft).reverse())));
      return { ok: true, data: { ok: true, publishable: true, assets: [GENE, CAPSULE], publish_receipt: receipt } };
    }
    return { ok: true, data: {} };
  };
  const answer = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'publish 1' });
  assert.equal(answer.ok, true, answer.text);
  assert.deepEqual(requests.map(({ path }) => path), ['/asset/reverify', '/asset/submit']);
  assert.deepEqual(requests[1].body.publish_receipt, receipt);
  assert.deepEqual(await ports.drafts.read(), []);
});

test('discarding a draft during reverification prevents its submission or resurrection', async () => {
  const { ports, requests } = await withDraft({ ...RESULT, publishable: false });
  ports.proxy.request = async (method, path, body) => {
    requests.push({ method, path, body });
    await ports.drafts.update(() => []);
    return { ok: true, data: { ok: true, publishable: true, assets: [GENE, CAPSULE], publish_receipt: RECEIPT } };
  };
  const answer = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'publish 1' });
  assert.equal(answer.ok, false);
  assert.match(answer.text, /discarded/);
  assert.deepEqual(requests.map(({ path }) => path), ['/asset/reverify']);
  assert.deepEqual(await ports.drafts.read(), []);
});

test('replacing a draft with the same id during reverification preserves the replacement', async () => {
  const { ports, requests, draft } = await withDraft({ ...RESULT, publishable: false });
  const replacement = { ...draft, createdAt: draft.createdAt + 1, title: 'Replacement' };
  ports.proxy.request = async (method, path, body) => {
    requests.push({ method, path, body });
    await ports.drafts.update(() => [replacement]);
    return { ok: true, data: { ok: true, publishable: true, assets: [GENE, CAPSULE], publish_receipt: RECEIPT } };
  };
  const answer = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'publish 1' });
  assert.equal(answer.ok, false);
  assert.match(answer.text, /discarded/);
  assert.deepEqual(requests.map(({ path }) => path), ['/asset/reverify']);
  assert.deepEqual(await ports.drafts.read(), [replacement]);
});

test('a malformed reverification response cannot submit or replace a draft', async () => {
  for (const data of [
    { ok: false, error: 'execution_failed' },
    { ok: true, publishable: false, assets: [GENE, CAPSULE], publish_receipt: RECEIPT },
    { ok: true, publishable: true, assets: [] },
    { ok: true, publishable: true, assets: [GENE, CAPSULE], publish_receipt: 'untrusted claim' },
    { ok: true, publishable: true, assets: [null, null], publish_receipt: RECEIPT },
    { ok: true, publishable: true, assets: [GENE, CAPSULE], publish_receipt: [] },
    { ok: true, publishable: true, assets: [GENE, GENE], publish_receipt: RECEIPT },
  ]) {
    const { ports, requests, draft } = await withDraft({ ...RESULT, publishable: false });
    ports.proxy.request = async (method, path) => { requests.push({ path }); return { ok: true, data }; };
    const answer = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'publish 1' });
    assert.equal(answer.ok, false);
    assert.deepEqual(requests.map(({ path }) => path), ['/asset/reverify']);
    assert.deepEqual(await ports.drafts.read(), [draft]);
  }
});

test('the installed Core contract distinguishes HTTP claims from a trusted verifier receipt', async () => {
  const trace = [{ command: 'node scripts/verify-retry.js', exit: 0 }];
  const input = {
    title: 'Bounded retry for transient HTTP failures',
    summary: 'When transient HTTP requests fail, retry only known retryable responses with bounded exponential backoff and jitter, then verify deterministic outcomes using an injected clock.',
    strategy: ['Classify transient failures before retrying.', 'Apply bounded exponential backoff with jitter.', 'Inject a clock and verify retry limits with a focused test.'],
    signals: ['HTTP timeout', 'retry limit'], validation: trace.map(row => row.command), execution: { trace },
    persist: false, publish: false,
  };
  const request = hub.createConversationVerificationRequest(input, input.validation, 'test-runtime', randomBytes(32).toString('hex'));
  const verifiedExecution = { trace, validation: input.validation, binding: { request, rootFingerprint: 'sha256:' + 'a'.repeat(64) } };
  for (const mode of ['unavailable', 'bound', 'promotion']) {
    const result = await hub.distillConversation(input, mode === 'bound' ? { verifiedExecution, registerPublishReceipt: () => {} } : {});
    assert.equal(result.ok, true);
    assert.equal(result.publishable, mode === 'bound');
    const { ports, requests } = await withDraft(result);
    ports.proxy.request = async (method, path, body) => {
      requests.push({ method, path, body });
      if (path === '/asset/reverify') {
        if (mode === 'unavailable') return { ok: false, error: 'publish_reverification_unavailable' };
        const candidate = hub.preparePublishReverification(body.assets, {});
        const request = hub.createPublishVerificationRequest(candidate.input, candidate.validation, 'test-runtime', randomBytes(32).toString('hex'));
        const execution = { trace, validation: candidate.validation, binding: { request, rootFingerprint: verifiedExecution.binding.rootFingerprint } };
        return { ok: true, data: { ok: true, publishable: true, ...hub.completePublishReverification(candidate, execution, {}) } };
      }
      hub.assertPublishBindingReceipt(body.assets, body.publish_receipt);
      return { ok: true, data: { message_id: 'fixture' } };
    };
    const answer = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'publish 1' });
    assert.equal(answer.ok, mode !== 'unavailable', answer.text);
    assert.deepEqual(requests.map(({ path }) => path), mode === 'promotion' ? ['/asset/reverify', '/asset/submit'] : [mode === 'bound' ? '/asset/submit' : '/asset/reverify']);
    assert.equal((await ports.drafts.read()).length, mode === 'unavailable' ? 1 : 0);
  }
});
