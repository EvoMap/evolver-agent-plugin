import assert from 'node:assert/strict';
import { test } from 'node:test';

import { distillPrompt } from '../../../lib/distill/prompt.js';
import { fileStoresOf } from '../../../lib/runtime/store/file-stores.js';
import {
  ASSET, PROMPT, callsNamed, deadPid, fakeClient, host, loadServer, reportsOf, requestsTo, startProxy, until, verifiedTurn,
} from './host.js';

async function harness(t, { answer, assets } = {}) {
  const proxy = await startProxy(t, { assets });
  const client = fakeClient(answer === undefined ? {} : { answer });
  const loaded = await loadServer({ client });
  const stores = fileStoresOf({ dir: proxy.stateDir, agent: 'opencode' });
  return { ...loaded, proxy, stores, oc: host(loaded.hooks) };
}

const distills = (proxy) => requestsTo(proxy, '/conversation/distill');
const deleted = (oc, sessionID) => oc.event('session.deleted', { sessionID, info: { id: sessionID } });

test('a verified turn is distilled once its session is deleted, in a tool-less helper session on its model', async (t) => {
  const { oc, proxy, client, stores } = await harness(t);
  await verifiedTurn(oc, 'ses_d');
  assert.deepEqual(callsNamed(client, 'prompt'), [], 'nothing runs at turn end');
  const candidate = (await stores.candidates.read()).ses_d;

  await deleted(oc, 'ses_d');
  await until(() => distills(proxy).length === 1, 'the distillation');
  await until(async () => (await stores.candidates.read()).ses_d === undefined, 'the candidate to settle');

  const [create] = callsNamed(client, 'create');
  assert.deepEqual(create.options.body.metadata, { evolver: 'distill' });
  assert.deepEqual(create.options.body.permission, [{ permission: '*', action: 'deny', pattern: '*' }]);
  assert.equal(typeof callsNamed(client, 'update')[0].options.body.time.archived, 'number');
  const [prompt] = callsNamed(client, 'prompt');
  assert.deepEqual(prompt.options.body.model, { providerID: 'anthropic', modelID: 'claude-sonnet' });
  assert.deepEqual(prompt.options.body.parts, [{ type: 'text', text: distillPrompt(candidate) }]);
  await until(() => callsNamed(client, 'delete').length === 1, 'the helper session to go');

  const [{ body }] = distills(proxy);
  assert.equal(body.platform, 'opencode');
  assert.equal(body.trigger, 'session_end');
  assert.equal(body.session_id, 'opencode:ses_d');
  assert.equal(body.user_prompt, PROMPT);
  assert.deepEqual(body.execution, { trace: [{ command: 'npm test 2>&1 | tail -5', exit: 0 }] });
  assert.deepEqual(body.distill_usage, { input: 900, output: 120 });
  assert.equal((await stores.drafts.read()).length, 1);
});

test('the helper session triggers none of this plugin\'s own work', async (t) => {
  const { oc, proxy, client } = await harness(t);
  await verifiedTurn(oc, 'ses_h');
  client.hold = new Promise(() => {});
  await deleted(oc, 'ses_h');
  await until(() => callsNamed(client, 'prompt').length === 1, 'the helper prompt');
  await until(() => reportsOf(proxy).length === 1, 'the person\'s report');

  const helper = { id: 'ses_helper1', ...callsNamed(client, 'create')[0].options.body };
  await oc.event('session.created', { sessionID: helper.id, info: helper });
  const output = await oc.prompt(helper.id, callsNamed(client, 'prompt')[0].options.body.parts[0].text);
  await oc.bash(helper.id, 'npm test', { exit: 0 });
  await oc.answer(helper.id, '{"summary":"x"}');
  await oc.idle(helper.id);
  await oc.event('session.deleted', { sessionID: helper.id, info: helper });

  assert.equal(output.parts.length, 1, 'nothing recalled into the distillation prompt');
  assert.equal(requestsTo(proxy, '/asset/fetch').length, 1, 'only the person\'s prompt was recalled for');
  assert.equal(reportsOf(proxy).length, 1);
});

test('a distillation the model failed keeps the candidate, and the next session start retries it', async (t) => {
  const { oc, proxy, client, stores } = await harness(t, { answer: 'not json' });
  await verifiedTurn(oc, 'ses_f');
  await deleted(oc, 'ses_f');
  await until(async () => (await stores.candidates.read()).ses_f?.attempts === 1, 'the failed try to count');
  const kept = (await stores.candidates.read()).ses_f;
  assert.equal(kept.closed, true);
  assert.equal(kept.claimedBy, null);
  assert.deepEqual(distills(proxy), []);
  assert.equal(callsNamed(client, 'delete').length, 1, 'the helper session is removed');

  client.answer = JSON.stringify({ title: 'Retry', summary: 'Retry Redis connections deterministically.' });
  await oc.prompt('ses_next', 'what does this repo do?');
  await until(() => distills(proxy).length === 1, 'the retry');
  await until(async () => (await stores.candidates.read()).ses_f === undefined, 'the candidate to settle');
});

test('a strategy whose turn never ended is reported aborted when its session is deleted', async (t) => {
  const { oc, proxy } = await harness(t);
  await oc.prompt('ses_cut', PROMPT);
  await deleted(oc, 'ses_cut');
  await until(() => reportsOf(proxy).length === 1, 'the aborted report');
  const [report] = reportsOf(proxy);
  assert.equal(report.task_id, 'opencode:ses_cut:1');
  assert.equal(report.outcome, 'failed');
  assert.deepEqual(report.evidence, { tier: 'none', applied: 'used', aborted: true, stage: 'immediate' });
});

test('shutting OpenCode down only writes what its sessions leave; the next instance delivers and distills it', async (t) => {
  const { oc, proxy, hooks, client, stores } = await harness(t);
  await oc.prompt('ses_open', PROMPT);
  await verifiedTurn(oc, 'ses_done', 'make the flaky redis connection retries in the worker tests pass');

  const before = reportsOf(proxy).length;
  await hooks.dispose();
  assert.deepEqual(callsNamed(client, 'prompt'), [], 'no helper session while shutting down');
  assert.equal(reportsOf(proxy).length, before, 'nothing delivered while shutting down');
  assert.equal((await stores.candidates.read()).ses_done.closed, true);

  const next = await loadServer({ client });
  await host(next.hooks).prompt('ses_later', 'what does this repo do?');
  await until(() => reportsOf(proxy).some((report) => report.task_id === 'opencode:ses_open:1' && report.evidence.aborted), 'the aborted report');
  await until(() => distills(proxy).length === 1, 'the leftover distillation');
  assert.equal(distills(proxy)[0].body.session_id, 'opencode:ses_done');
});

test("the next session reports a killed process's open strategies and distills its leftover candidate", async (t) => {
  const { oc, proxy, client, stores } = await harness(t);
  const dead = deadPid();
  await stores.sessions.update('ses_killed', () => ({ turn: 4, open: true, pid: dead, injected: { [ASSET.asset_id]: { turn: 4, injectedAt: Date.now(), strategyText: '1. a.' } } }));
  await stores.sessions.update('ses_idle', () => ({ turn: 1, open: true, pid: process.pid, injected: { 'sha256:idle': { turn: 1, injectedAt: Date.now(), strategyText: '1. a.' } } }));
  await stores.candidates.update((pending) => ({
    ...pending,
    ses_killed: { prompt: 'p', commands: ['npm test'], paths: [], checks: [{ command: 'npm test', failed: false }], answer: 'a', model: { providerID: 'p', modelID: 'm' }, turn: 4, pid: dead, attempts: 0, at: 1 },
  }));

  await oc.prompt('ses_new', 'what does this repo do?');
  await until(() => reportsOf(proxy).length === 1, 'the orphaned report');
  await until(() => distills(proxy).length === 1, 'the leftover distillation');
  const [report] = reportsOf(proxy);
  assert.equal(report.asset_id, ASSET.asset_id);
  assert.equal(report.task_id, 'opencode:ses_killed:4');
  assert.equal(report.evidence.aborted, true);
  assert.deepEqual(callsNamed(client, 'prompt')[0].options.body.model, { providerID: 'p', modelID: 'm' });
});

test('a session resumed after its OpenCode was killed reports the open strategy aborted and numbers on', async (t) => {
  const { oc, proxy, stores } = await harness(t, { assets: [] });
  await stores.sessions.update('ses_res', () => ({ turn: 4, open: true, pid: deadPid(), injected: { [ASSET.asset_id]: { turn: 4, injectedAt: Date.now(), strategyText: '1. a.' } } }));
  await oc.prompt('ses_res', 'go on with the redis connection retries');
  await until(() => reportsOf(proxy).length === 1, 'the aborted report');
  const [report] = reportsOf(proxy);
  assert.equal(report.task_id, 'opencode:ses_res:4');
  assert.equal(report.evidence.aborted, true);
  assert.equal((await stores.sessions.read('ses_res')).turn, 5);
});

test('injections and candidates of another agent are never claimed', async (t) => {
  const { oc, proxy, client } = await harness(t);
  const dead = deadPid();
  const cursor = fileStoresOf({ dir: proxy.stateDir, agent: 'cursor' });
  await cursor.sessions.update('cur_1', () => ({ turn: 1, open: true, pid: dead, injected: { 'sha256:cursor': { turn: 1, injectedAt: Date.now(), strategyText: '' } } }));
  await cursor.candidates.update(() => ({ cur_1: { pid: dead, at: 1, model: 'x', prompt: 'p', commands: [], paths: [], checks: [], answer: 'a', attempts: 0 } }));

  await oc.prompt('ses_new', 'what does this repo do?');
  await oc.answer('ses_new', 'It parses JSON.');
  await oc.idle('ses_new');
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  assert.deepEqual(reportsOf(proxy), []);
  assert.deepEqual(callsNamed(client, 'prompt'), []);
});
