import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  ASSET, PROMPT, fakeClient, host, loadServer, reportsOf, requestsTo, startProxy, until, verifiedTurn,
} from './host.js';

async function harness(t, { client, assets } = {}) {
  const proxy = await startProxy(t, { assets });
  const loaded = await loadServer({ client });
  return { ...loaded, proxy, oc: host(loaded.hooks) };
}

const pending = (proxy) => {
  try {
    return JSON.parse(readFileSync(join(proxy.stateDir, 'opencode-distill-pending.json'), 'utf8'));
  } catch {
    return {};
  }
};

test('the plugin registers no tool, and /evolver-evolve as its one prompt command', async (t) => {
  const { hooks, plugin } = await harness(t);
  assert.equal(plugin.id, 'evomap.evolver');
  assert.equal(hooks.tool, undefined);
  const cfg = { command: { mine: { template: 'x' } } };
  await hooks.config(cfg);
  assert.deepEqual(Object.keys(cfg.command), ['evolver-evolve', 'mine']);
  assert.doesNotMatch(cfg.command['evolver-evolve'].template, /evolver_[a-z_]+/);
  assert.equal(cfg.skills, undefined);
});

test('the recalled strategy is the only thing added to the prompt, behind it, as synthetic text', async (t) => {
  const { oc, proxy } = await harness(t);
  const output = await oc.prompt('ses_a', PROMPT, [{ id: 'prt_1', type: 'text', synthetic: true, text: 'attached file contents' }]);
  assert.equal(output.parts.length, 3);
  const part = output.parts.at(-1);
  assert.equal(part.synthetic, true);
  assert.equal(part.sessionID, 'ses_a');
  assert.equal(part.messageID, output.message.id);
  assert.match(part.id, /^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.match(part.text, /^\[Evolution Memory\] Fix flaky Redis connection retries/);
  assert.ok(part.text.endsWith('Apply them where they fit.'));
  assert.deepEqual(requestsTo(proxy, '/asset/fetch')[0].body, { text: PROMPT });
});

test('a verified turn reports its strategy with the last check and becomes the session candidate, on its model', async (t) => {
  const { oc, proxy } = await harness(t);
  await verifiedTurn(oc, 'ses_ok');
  await until(() => reportsOf(proxy).length === 1, 'the turn-end report');
  const [report] = reportsOf(proxy);
  assert.equal(report.task_id, 'opencode:ses_ok:1');
  assert.equal(report.outcome, 'success');
  assert.deepEqual(report.evidence, { tier: 'L1', applied: 'used', check: { kind: 'test', passed: true, fail_then_pass: false }, aborted: false, stage: 'immediate' });
  const candidate = pending(proxy).ses_ok;
  assert.equal(candidate.prompt, PROMPT);
  assert.deepEqual(candidate.model, { providerID: 'anthropic', modelID: 'claude-sonnet' });
  assert.deepEqual(candidate.checks, [{ command: 'npm test 2>&1 | tail -5', failed: false }]);
  assert.equal(candidate.pid, process.pid);
});

test('a correction drops the candidate; a question keeps it', async (t) => {
  const { oc, proxy } = await harness(t);
  await verifiedTurn(oc, 'ses_c');
  await oc.prompt('ses_c', '这样不对吧？');
  assert.ok(pending(proxy).ses_c);
  await oc.answer('ses_c', 'It holds.');
  await oc.idle('ses_c');
  await oc.prompt('ses_c', '不对，还是报错');
  assert.equal(pending(proxy).ses_c, undefined);
});

test('a turn leaves no candidate when its check failed, it ran nothing, or it was interrupted', async (t) => {
  const { oc, proxy } = await harness(t, { assets: [] });
  await oc.prompt('ses_f', 'fix the build');
  await oc.tool('ses_f', 'edit', { filePath: 'a.js', oldString: 'a', newString: 'b' });
  await oc.bash('ses_f', 'npm run build', { exit: 2, output: 'error TS2304' });
  await oc.answer('ses_f', 'Tried.');
  await oc.idle('ses_f');
  await oc.prompt('ses_n', 'what does this repo do?');
  await oc.answer('ses_n', 'It parses JSON.');
  await oc.idle('ses_n');
  await oc.prompt('ses_x', 'fix the build');
  await oc.tool('ses_x', 'edit', { filePath: 'a.js', oldString: 'a', newString: 'b' });
  await oc.bash('ses_x', 'npm run build', { exit: 0 });
  await oc.answer('ses_x', 'Stopped.', { error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } });
  await oc.idle('ses_x');
  assert.deepEqual(Object.keys(pending(proxy)), []);
});

test('an interrupted turn is reported aborted and an errored one failed, from how OpenCode ended them', async (t) => {
  const { oc, proxy } = await harness(t);
  await oc.prompt('ses_ab', PROMPT);
  await oc.event('session.error', { sessionID: 'ses_ab', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } });
  await oc.idle('ses_ab');
  await oc.prompt('ses_er', PROMPT);
  await oc.answer('ses_er', '');
  await oc.event('session.error', { sessionID: 'ses_er', error: { name: 'APIError', data: { message: 'overloaded' } } });
  await oc.idle('ses_er');
  await oc.idle('ses_er');
  await until(() => reportsOf(proxy).length === 2, 'both reports');
  const byTask = Object.fromEntries(reportsOf(proxy).map((report) => [report.task_id, report]));
  assert.equal(byTask['opencode:ses_ab:1'].evidence.aborted, true);
  assert.equal(byTask['opencode:ses_ab:1'].outcome, 'failed');
  assert.equal(byTask['opencode:ses_er:1'].evidence.aborted, false);
  assert.equal(byTask['opencode:ses_er:1'].outcome, 'failed');
});

test('a check the person interrupted counts as no check, not a failed one', async (t) => {
  const { oc, proxy } = await harness(t);
  await oc.prompt('ses_int', PROMPT);
  await oc.bash('ses_int', 'npm test', { exit: null, output: 'ℹ pass 2\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>' });
  await oc.event('session.error', { sessionID: 'ses_int', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } });
  await oc.idle('ses_int');
  await until(() => reportsOf(proxy).length === 1, 'the report');
  const [report] = reportsOf(proxy);
  assert.equal(report.evidence.check, undefined);
  assert.equal(report.evidence.tier, 'none');
});

test('a prompt sent while the session is busy joins the running turn', async (t) => {
  const { oc, proxy } = await harness(t);
  await oc.prompt('ses_busy', PROMPT);
  const joined = await oc.prompt('ses_busy', 'also log each redis connection retry attempt');
  assert.equal(joined.parts.length, 1);
  assert.equal(requestsTo(proxy, '/asset/fetch').length, 1);
  await oc.answer('ses_busy', 'Done.');
  await oc.idle('ses_busy');
  await until(() => reportsOf(proxy).length === 1, 'one report');
  assert.equal(reportsOf(proxy)[0].task_id, 'opencode:ses_busy:1');
});

test('turn numbers continue in a session resumed by a later OpenCode instance', async (t) => {
  const other = { ...ASSET, asset_id: `sha256:${'b'.repeat(64)}` };
  const { oc, proxy } = await harness(t, { assets: [ASSET, other] });
  await oc.prompt('ses_r', PROMPT);
  await oc.answer('ses_r', 'Done.');
  await oc.idle('ses_r');
  await until(() => reportsOf(proxy).length === 1, 'the first report');
  const resumed = host((await loadServer()).hooks);
  await resumed.prompt('ses_r', 'now make the redis connection retries in the worker tests stable too');
  await resumed.answer('ses_r', 'Done.');
  await resumed.idle('ses_r');
  await until(() => reportsOf(proxy).length === 2, 'both reports');
  assert.deepEqual(reportsOf(proxy).map((report) => [report.task_id, report.asset_id]), [['opencode:ses_r:1', ASSET.asset_id], ['opencode:ses_r:2', other.asset_id]]);
});

test('subagent and distillation-helper sessions are neither recalled for nor recorded', async (t) => {
  const client = fakeClient({ sessions: { ses_child: { id: 'ses_child', parentID: 'ses_parent' } } });
  const { oc, proxy } = await harness(t, { client });
  await oc.event('session.created', { sessionID: 'ses_help', info: { id: 'ses_help', metadata: { evolver: 'distill' } } });
  const helper = await oc.prompt('ses_help', PROMPT);
  const child = await oc.prompt('ses_child', PROMPT);
  await oc.bash('ses_help', 'npm test', { exit: 0 });
  await oc.answer('ses_help', '{"summary":"x"}');
  await oc.idle('ses_help');
  await oc.idle('ses_child');
  assert.equal(helper.parts.length, 1);
  assert.equal(child.parts.length, 1);
  assert.deepEqual(requestsTo(proxy, '/asset/fetch'), []);
  assert.deepEqual(pending(proxy), {});
});

test('/evolver-evolve hands the agent the checkpoint with its focus, and recalls nothing for it', async (t) => {
  const { hooks, oc, proxy } = await harness(t);
  const cfg = {};
  await hooks.config(cfg);
  const parts = [{ type: 'text', text: `${cfg.command['evolver-evolve'].template}\n\nthe redis retries` }];
  await hooks['command.execute.before']({ command: 'evolver-evolve', sessionID: 'ses_e', arguments: ' the redis retries ' }, { parts });
  assert.match(parts[0].text, /^Take a deliberate evolution step[\s\S]*\n\nFocus on: the redis retries$/);
  await hooks['chat.message']({ sessionID: 'ses_e' }, { message: { id: 'msg_e' }, parts });
  assert.deepEqual(requestsTo(proxy, '/asset/fetch'), []);
  assert.equal(parts.length, 1);
  await oc.idle('ses_e');
});

test('a message with only synthetic text, as a searched strategy joins the session, starts no turn', async (t) => {
  const { hooks, proxy } = await harness(t);
  const output = { message: { id: 'msg_s' }, parts: [{ type: 'text', synthetic: true, text: PROMPT }] };
  await hooks['chat.message']({ sessionID: 'ses_s' }, output);
  assert.equal(output.parts.length, 1);
  assert.deepEqual(requestsTo(proxy, '/asset/fetch'), []);
});

test('a prompt still being looked up when its session is deleted does not bring the session back', async (t) => {
  let release;
  const client = fakeClient();
  const get = client.session.get;
  client.session.get = async (options) => { await new Promise((resolve) => { release = resolve; }); return get(options); };
  const { hooks, oc, proxy } = await harness(t, { client });
  const prompt = hooks['chat.message']({ sessionID: 'ses_gone' }, { message: { id: 'msg_gone' }, parts: [{ type: 'text', text: PROMPT }] });
  await until(() => release, 'the session lookup');
  const deleted = oc.event('session.deleted', { sessionID: 'ses_gone', info: { id: 'ses_gone' } });
  release();
  await prompt;
  await deleted;
  assert.deepEqual(requestsTo(proxy, '/asset/fetch'), []);
});

test('the first prompt of a session in this instance starts it, and the engine notice is a toast for the person', { todo: 'lib/agent/driver.js loses the session-start notice: its sessionStart handler does not destructure `payload`' }, async (t) => {
  const { oc, proxy, client } = await harness(t);
  mkdirSync(proxy.stateDir, { recursive: true });
  writeFileSync(join(proxy.stateDir, 'opencode-engine.json'), JSON.stringify({ status: 'started', version: '2.0.46', at: 1 }));
  await oc.prompt('ses_n', PROMPT);
  await until(() => client.calls.some((call) => call.name === 'toast'), 'the notice toast', 1_000);
  assert.match(client.calls.find((call) => call.name === 'toast').options.body.message, /^\[Evolver\] The Evolver Proxy was not running/);
});
