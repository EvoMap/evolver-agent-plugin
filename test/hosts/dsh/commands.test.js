import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EVOLVE_PROMPT } from '../../../lib/app/commands/evolve.js';
import {
  ASSET, DSH, PROMPT, fakeLlm, reportsOf, reportsQueued, requestsTo, startDsh, startProxy, stateFile, until, verifiedTurn,
} from './host.js';

const fetches = (proxy) => requestsTo(proxy, '/asset/fetch');

test('/evolver-status answers in dsh\'s UI and nothing of it reaches the agent', async (t) => {
  await startProxy(t);
  const dsh = await startDsh();
  const agent = await dsh.createAgent();
  const result = await dsh.command(agent, 'evolver-status');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /^Evolver Proxy running \(public hub, node node_test\)\./);
  assert.match(result.text, /No distillation candidate in this session\./);
  assert.deepEqual([agent.injected, agent.followups], [[], []]);
  assert.deepEqual(await dsh.command(agent, 'evolver-search'), { kind: 'error', text: 'Usage: /evolver-search <task description or error text>' });
});

test('/evolver-search hands its strategy to the conversation, and the turn that saw it reports its reuse', async (t) => {
  const proxy = await startProxy(t);
  const dsh = await startDsh();
  const agent = await dsh.createAgent();
  await dsh.preStep(agent, { turn: 1, step: 1, messages: [{ ...DSH.preStep.prompt.messages[0], content: [{ type: 'text', text: 'look at the build script' }] }] });
  const result = await dsh.command(agent, 'evolver-search', ' fix the flaky redis connection retries');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /^\[Evolution Memory\] Fix flaky Redis connection retries/);
  assert.equal(agent.injected.length, 1);
  assert.deepEqual(agent.injected[0].source, DSH.preStep.searchedStrategyNextStep.messages[0].source);
  assert.equal(agent.injected[0].content[0].text, result.text);
  dsh.event(agent, 'assistant/message', { ...DSH.assistantMessage.answer, turn: 1 });
  dsh.event(agent, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  await until(() => reportsOf(proxy).length === 1, 'the searched strategy\'s report');
  assert.equal(reportsOf(proxy)[0].asset_id, ASSET.asset_id);
  assert.equal(reportsOf(proxy)[0].task_id, `dsh:${agent.session.id}:1`);
});

test('/evolver-evolve becomes a follow-up turn of its own, which is recalled for nothing and never a candidate', async (t) => {
  const proxy = await startProxy(t);
  const dsh = await startDsh();
  const agent = await dsh.createAgent();
  assert.deepEqual(await dsh.command(agent, 'evolver-evolve', ' the retry path '), { kind: 'success', text: 'Running /evolver-evolve.' });
  const [followup] = agent.followups;
  assert.deepEqual(followup.source, DSH.preStep.evolveFollowup.messages[0].source);
  assert.equal(followup.content[0].text, `${EVOLVE_PROMPT}\n\nFocus on: the retry path`);
  assert.doesNotMatch(followup.content[0].text, /evolver_[a-z_]+/);

  await verifiedTurn(dsh, agent, { firstMessages: [followup] });
  await dsh.settled(agent);
  assert.deepEqual(reportsQueued(proxy), []);
  assert.deepEqual(fetches(proxy), []);
  assert.deepEqual(stateFile(proxy, 'dsh-distill-pending.json'), {});
  const sessions = (await import('node:fs')).readdirSync(proxy.stateDir).filter((name) => name.startsWith('dsh-session-'));
  assert.equal(stateFile(proxy, sessions[0]).isCommand, true);

  await verifiedTurn(dsh, agent, { turn: 2, prompt: PROMPT });
  await until(() => reportsOf(proxy).length === 1, 'the next real turn\'s report');
  assert.equal(reportsOf(proxy)[0].task_id, `dsh:${agent.session.id}:2`);
});

test('/evolver-distill distills the session\'s verified turn now, and /evolver-drafts lists the draft', async (t) => {
  await startProxy(t);
  const llm = fakeLlm();
  const dsh = await startDsh({ llm });
  const agent = await dsh.createAgent();
  assert.deepEqual(await dsh.command(agent, 'evolver-distill'), { kind: 'error', text: 'Nothing to distill yet: no turn of this session finished verified.' });
  await verifiedTurn(dsh, agent);
  await dsh.settled(agent);
  const distilled = await dsh.command(agent, 'evolver-distill', 'the retry option');
  assert.equal(distilled.kind, 'success');
  assert.match(distilled.text, /^Distilled "Stabilise Redis retries" into a draft/);
  assert.match(llm.calls[0].messages[0].content[0].text, /Focus on: the retry option/);
  const drafts = await dsh.command(agent, 'evolver-drafts');
  assert.equal(drafts.kind, 'success');
  assert.match(drafts.text, /Stabilise Redis retries/);
});
