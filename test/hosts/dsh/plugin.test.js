import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ASSET, DSH, PROMPT, bash, fakeLlm, reportsOf, reportsQueued, requestsTo, startDsh, startProxy, stateFile, until, validatedConfig, verifiedTurn, write,
} from './host.js';

const fetches = (proxy) => requestsTo(proxy, '/asset/fetch');
const distills = (proxy) => requestsTo(proxy, '/conversation/distill');
const added = (decision, given) => decision.messages.slice(given);

test('the packed plugin loads as cordis loads it, registers no tool, and validates its options', async (t) => {
  await startProxy(t);
  const dsh = await startDsh();
  assert.equal(dsh.plugin.name, 'evolver-plugin');
  assert.deepEqual(dsh.plugin.inject, ['tools']);
  assert.deepEqual(dsh.tools, []);
  assert.deepEqual([...dsh.listeners.keys()].sort(), ['agent/created', 'agent/pre-step', 'agent/session-start', 'session/disposed', 'session/event', 'tools/execute']);
  const described = (commands) => commands.map(({ name, description, input }) => ({ name, description, ...(input && { input }) })).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(described(dsh.commands), described(DSH.commandsListed), 'what dsh 0.2 listed after registering them');
  assert.deepEqual(validatedConfig(dsh.plugin, undefined), {});
  assert.deepEqual(validatedConfig(dsh.plugin, { proxyPort: 19821, skillEnabled: true, editToolNames: ['write'] }), { proxyPort: 19821, skillEnabled: true, editToolNames: ['write'] });
  assert.throws(() => validatedConfig(dsh.plugin, { proxyPort: 70_000 }), /Invalid Evolver option proxyPort: 70000/);
  assert.throws(() => validatedConfig(dsh.plugin, { assetPrimeEnabled: 'no' }), /assetPrimeEnabled/);
  assert.throws(() => validatedConfig(dsh.plugin, ['x']), /must be an object/);
});

test('the recalled strategy joins the step that carries the prompt, behind it, as plugin context', async (t) => {
  const proxy = await startProxy(t);
  const dsh = await startDsh();
  const agent = await dsh.createAgent();
  const messages = [{ ...DSH.preStep.prompt.messages[0], content: [{ type: 'text', text: PROMPT }] }, DSH.preStep.prompt.messages[1]];
  const decision = await dsh.preStep(agent, { turn: 1, step: 1, messages });
  const [strategy] = added(decision, 2);
  assert.equal(decision.kind, 'enter');
  assert.deepEqual(decision.messages.slice(0, 2), messages);
  assert.deepEqual(strategy.source, { kind: 'plugin:evolver', form: 'recall' });
  assert.equal(strategy.role, 'user');
  assert.match(strategy.id, /^[0-9a-f-]{36}$/);
  assert.ok(Object.isFrozen(strategy));
  assert.match(strategy.content[0].text, /^\[Evolution Memory\] Fix flaky Redis connection retries/);
  assert.ok(strategy.content[0].text.endsWith('Apply them where they fit.'));
  assert.deepEqual(fetches(proxy)[0].body, { text: PROMPT });
  const later = await dsh.preStep(agent, { turn: 1, step: 2, messages: [] });
  assert.deepEqual(later.messages, [], 'a later step of the turn adds nothing');
});

test('a verified turn is reported with its last check and becomes the session\'s candidate, on its route', async (t) => {
  const proxy = await startProxy(t);
  const dsh = await startDsh();
  const agent = await dsh.createAgent({ sessionId: DSH.agentCreated.startup.sessionId });
  await verifiedTurn(dsh, agent);
  await until(() => reportsOf(proxy).length === 1, 'the turn-end report');
  const [report] = reportsOf(proxy);
  assert.equal(report.task_id, `dsh:${DSH.agentCreated.startup.sessionId}:1`);
  assert.equal(report.asset_id, ASSET.asset_id);
  assert.equal(report.outcome, 'success');
  assert.deepEqual(report.evidence, { tier: 'L1', applied: 'used', check: { kind: 'test', passed: true, fail_then_pass: false }, aborted: false, stage: 'immediate' });
  await until(() => stateFile(proxy, 'dsh-distill-pending.json')[agent.session.id], 'the candidate');
  const candidate = stateFile(proxy, 'dsh-distill-pending.json')[agent.session.id];
  assert.equal(candidate.prompt, PROMPT);
  assert.deepEqual(candidate.model, { provider: 'deepseek-official', model: 'deepseek-flash' });
  assert.deepEqual(candidate.checks, [{ command: 'npm test 2>&1 | tail -5', failed: false }]);
  assert.equal(candidate.answer, 'Set maxRetriesPerRequest to null; the suite passes.');
  assert.equal(candidate.pid, process.pid);
});

test('a session dsh disposes is distilled through the model service on the session\'s own route', async (t) => {
  const proxy = await startProxy(t);
  const llm = fakeLlm();
  const dsh = await startDsh({ llm });
  const agent = await dsh.createAgent();
  await verifiedTurn(dsh, agent);
  await until(() => stateFile(proxy, 'dsh-distill-pending.json')[agent.session.id], 'the candidate');
  assert.equal(llm.calls.length, 0, 'nothing runs at turn end');
  dsh.disposeSession(agent);
  await until(() => distills(proxy).length === 1, 'the distillation');
  const [call] = llm.calls;
  assert.equal(call.provider, 'deepseek-official');
  assert.equal(call.model, 'deepseek-flash');
  assert.equal(call.messages.length, 1);
  assert.deepEqual(call.messages[0].source, { kind: 'plugin:evolver', form: 'instructions' });
  assert.match(call.messages[0].content[0].text, /^Below is the record of a task/);
  const [{ body }] = distills(proxy);
  assert.equal(body.platform, 'dsh');
  assert.equal(body.trigger, 'session_end');
  assert.equal(body.session_id, `dsh:${agent.session.id}`);
  assert.deepEqual(body.distill_usage, { inputTokens: 900, outputTokens: 120, totalTokens: 1020 });
  await until(() => stateFile(proxy, 'dsh-distill-drafts.json', []).length === 1, 'the draft');
});

test('a failed model call keeps the candidate for the next session start', async (t) => {
  const proxy = await startProxy(t);
  const llm = {
    calls: [],
    async *stream(options) {
      this.calls.push(options);
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'quota exceeded', code: 'QUOTA_EXCEEDED' } } };
    },
  };
  const dsh = await startDsh({ llm });
  const agent = await dsh.createAgent();
  await verifiedTurn(dsh, agent);
  await until(() => stateFile(proxy, 'dsh-distill-pending.json')[agent.session.id], 'the candidate');
  dsh.disposeSession(agent);
  await until(() => llm.calls.length === 1, 'the distillation attempt');
  await until(() => stateFile(proxy, 'dsh-distill-pending.json')[agent.session.id]?.claimedBy === null, 'the claim to be released');
  assert.deepEqual(distills(proxy), []);
});

test('the plugin\'s unload ends the open sessions; the next dsh process distills what they left', async (t) => {
  const proxy = await startProxy(t);
  const first = await startDsh();
  const done = await first.createAgent();
  await verifiedTurn(first, done);
  await until(() => stateFile(proxy, 'dsh-distill-pending.json')[done.session.id], 'the candidate');
  const running = await first.createAgent();
  await first.preStep(running, { turn: 1, step: 1, messages: [{ ...DSH.preStep.prompt.messages[0], content: [{ type: 'text', text: PROMPT }] }] });
  await first.dispose();
  assert.equal(stateFile(proxy, 'dsh-distill-pending.json')[done.session.id].closed, true);
  await until(() => reportsOf(proxy).some((report) => report.task_id === `dsh:${running.session.id}:1`), 'the open turn\'s report');
  const aborted = reportsOf(proxy).find((report) => report.task_id === `dsh:${running.session.id}:1`);
  assert.equal(aborted.evidence.aborted, true);
  assert.equal(aborted.outcome, 'failed');

  const llm = fakeLlm();
  const next = await startDsh({ llm });
  await next.createAgent();
  await until(() => distills(proxy).length === 1, 'the leftover distillation');
  assert.equal(distills(proxy)[0].body.session_id, `dsh:${done.session.id}`);
});

test('a recall slower than the step\'s wait joins the turn\'s next step and is reported with it', async (t) => {
  const proxy = await startProxy(t, { delays: { '/asset/fetch': 7_000 } });
  const dsh = await startDsh();
  const agent = await dsh.createAgent();
  const first = await dsh.preStep(agent, { turn: 1, step: 1, messages: [{ ...DSH.preStep.prompt.messages[0], content: [{ type: 'text', text: PROMPT }] }] });
  assert.equal(first.messages.length, 1, 'the step went ahead without it');
  await new Promise((resolve) => { setTimeout(resolve, 2_000); });
  const second = await dsh.preStep(agent, { turn: 1, step: 2, messages: [] });
  assert.equal(second.messages.length, 1);
  assert.match(second.messages[0].content[0].text, /^\[Evolution Memory\]/);
  const third = await dsh.preStep(agent, { turn: 1, step: 3, messages: [] });
  assert.deepEqual(third.messages, [], 'joined once');
  dsh.event(agent, 'assistant/message', { ...DSH.assistantMessage.answer, turn: 1 });
  dsh.event(agent, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  await until(() => reportsOf(proxy).length === 1, 'the late strategy\'s report');
  assert.equal(reportsOf(proxy)[0].task_id, `dsh:${agent.session.id}:1`);
});

test('a recall that lands after its turn ended is neither joined nor reported', async (t) => {
  const proxy = await startProxy(t, { delays: { '/asset/fetch': 7_000 } });
  const dsh = await startDsh();
  const agent = await dsh.createAgent();
  await dsh.preStep(agent, { turn: 1, step: 1, messages: [{ ...DSH.preStep.prompt.messages[0], content: [{ type: 'text', text: PROMPT }] }] });
  dsh.event(agent, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  await new Promise((resolve) => { setTimeout(resolve, 2_000); });
  const stale = await dsh.preStep(agent, { turn: 1, step: 2, messages: [] });
  assert.deepEqual(stale.messages, []);
  assert.deepEqual(agent.injected, []);
  assert.deepEqual(reportsOf(proxy), []);
});

test('a session resumed by a later dsh process goes on counting its turns', async (t) => {
  const other = { ...ASSET, asset_id: `sha256:${'b'.repeat(64)}` };
  const proxy = await startProxy(t, { assets: [ASSET, other] });
  const sessionId = DSH.agentCreated.resume.sessionId;
  const first = await startDsh();
  await first.turn(await first.createAgent({ sessionId }));
  await until(() => reportsOf(proxy).length === 1, 'the first report');
  await first.dispose();
  const next = await startDsh();
  const resumed = await next.createAgent({ sessionId, source: DSH.agentCreated.resume.source });
  await next.turn(resumed, { turn: DSH.preStep.resumedPrompt.turn, prompt: 'now make the redis connection retries in the worker tests stable too' });
  await until(() => reportsOf(proxy).length === 2, 'both reports');
  assert.deepEqual(reportsOf(proxy).map((report) => [report.task_id, report.asset_id]), [[`dsh:${sessionId}:1`, ASSET.asset_id], [`dsh:${sessionId}:2`, other.asset_id]]);
});

test('an interrupted turn is reported aborted and a failed model request failed, from turn/end', async (t) => {
  const proxy = await startProxy(t);
  const dsh = await startDsh();
  const stopped = await dsh.createAgent();
  await dsh.turn(stopped, { answer: '', reason: { kind: 'aborted', reason: { kind: 'user' } } });
  const failed = await dsh.createAgent();
  await dsh.turn(failed, { answer: '', reason: DSH.turnEnd.error.reason });
  await until(() => reportsOf(proxy).length === 2, 'both reports');
  const byTask = Object.fromEntries(reportsOf(proxy).map((report) => [report.task_id, report]));
  assert.equal(byTask[`dsh:${stopped.session.id}:1`].evidence.aborted, true);
  assert.equal(byTask[`dsh:${stopped.session.id}:1`].outcome, 'failed');
  assert.equal(byTask[`dsh:${failed.session.id}:1`].evidence.aborted, false);
  assert.equal(byTask[`dsh:${failed.session.id}:1`].outcome, 'failed');
});

test('a failing check, a run still in the background and an unfinished turn leave no candidate', async (t) => {
  const proxy = await startProxy(t, { assets: [] });
  const dsh = await startDsh();
  const failing = await dsh.createAgent();
  await dsh.turn(failing, { tools: [write('lib/redis.js'), bash('npm test', { exitCode: 1, text: 'ℹ fail 1\n[exit code: 1]' })] });
  const background = await dsh.createAgent();
  await dsh.turn(background, { tools: [write('lib/redis.js'), { ...DSH.tools.bashBackground, arguments: { ...DSH.tools.bashBackground.arguments, command: 'npm test' } }] });
  const cut = await dsh.createAgent();
  await verifiedTurn(dsh, cut, { reason: { kind: 'max-tokens' } });
  await Promise.all([failing, background, cut].map((agent) => dsh.settled(agent)));
  assert.deepEqual(stateFile(proxy, 'dsh-distill-pending.json'), {});
});

test('a correction drops the candidate and revises the last turn\'s report', async (t) => {
  const proxy = await startProxy(t);
  const dsh = await startDsh();
  const agent = await dsh.createAgent();
  await verifiedTurn(dsh, agent);
  await until(() => stateFile(proxy, 'dsh-distill-pending.json')[agent.session.id], 'the candidate');
  await dsh.turn(agent, { turn: 2, prompt: '不对，还是报错' });
  assert.equal(stateFile(proxy, 'dsh-distill-pending.json')[agent.session.id], undefined);
  await until(() => reportsOf(proxy).some((report) => report.task_id.endsWith(':1:correction')), 'the correction report');
  const correction = reportsOf(proxy).find((report) => report.task_id.endsWith(':1:correction'));
  assert.equal(correction.outcome, 'failed');
  assert.equal(correction.evidence.tier, 'L3');
});

test('a subagent\'s session is neither recalled for nor recorded', async (t) => {
  const proxy = await startProxy(t);
  const dsh = await startDsh();
  const subagent = await dsh.createAgent({ sessionId: DSH.agentCreated.subagent.sessionId, header: { origin: 'subagent', parentSession: DSH.agentCreated.subagent.header.parentSession, delegationDepth: 1 } });
  const decision = await dsh.preStep(subagent, { turn: 1, step: 1, messages: DSH.subagent.prompt.messages });
  assert.equal(decision.messages.length, DSH.subagent.prompt.messages.length);
  await dsh.tool(subagent, DSH.subagent.bash);
  dsh.event(subagent, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  dsh.disposeSession(subagent);
  await dsh.settled(subagent);
  assert.deepEqual(fetches(proxy), []);
  assert.deepEqual(reportsQueued(proxy), []);
  assert.deepEqual(stateFile(proxy, 'dsh-distill-pending.json'), {});
});

test('a turn no person\'s message opened is recalled for nothing and records nothing', async (t) => {
  const proxy = await startProxy(t);
  const dsh = await startDsh();
  const agent = await dsh.createAgent();
  const steps = await dsh.turn(agent, { firstMessages: DSH.preStep.lateNoteNextStep.messages, tools: [bash('npm test', { text: 'ℹ pass 1' })] });
  assert.equal(steps[0].messages.length, 1);
  await dsh.settled(agent);
  assert.deepEqual(reportsQueued(proxy), []);
  assert.deepEqual(fetches(proxy), []);
  assert.deepEqual(stateFile(proxy, 'dsh-distill-pending.json'), {});
});

test('options: proxyPort reaches the Proxy when settings name none, and assetPrimeEnabled: false turns recall off', async (t) => {
  const proxy = await startProxy(t);
  const { rmSync } = await import('node:fs');
  rmSync(`${proxy.home}/.evolver/settings.json`);
  const dsh = await startDsh({ config: { proxyPort: proxy.port } });
  const agent = await dsh.createAgent();
  const decision = await dsh.preStep(agent, { turn: 1, step: 1, messages: [{ ...DSH.preStep.prompt.messages[0], content: [{ type: 'text', text: PROMPT }] }] });
  assert.equal(decision.messages.length, 2);
  const off = await startDsh({ config: { proxyPort: proxy.port, assetPrimeEnabled: false } });
  const quiet = await off.createAgent();
  const plain = await off.preStep(quiet, { turn: 1, step: 1, messages: [{ ...DSH.preStep.prompt.messages[0], content: [{ type: 'text', text: PROMPT }] }] });
  assert.equal(plain.messages.length, 1);
  assert.equal(fetches(proxy).length, 1);
});
