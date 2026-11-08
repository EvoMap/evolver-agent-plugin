import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import profile from '../../hosts/kimi/profile.js';
import { createDriver } from '../../lib/agent/driver.js';
import { reconcileNativeTurn, recoverNativeTurns } from '../../lib/app/native-turn.js';
import { taskSessionId } from '../../lib/app/turn-reports.js';
import { turnTaskId } from '../../lib/reuse.js';
import { nativeFactsOf } from '../../lib/runtime/native-facts.js';
import { monitorNativeTurn } from '../../lib/runtime/native-monitor.js';
import { ASSET, memoryPorts, PROMPT } from '../app/memory-ports.js';

const route = { alias: 'selected', providerId: 'fixture-account', model: 'fixture-model', protocol: 'openai',
  endpoint: 'https://example.test/v1', effort: 'off', binding: 'fixture', configRevision: 'fixture' };
const nextRoute = { ...route, providerId: 'fixture-account-next', binding: 'fixture-next' };
const nextPrompt = 'Now update the documentation.';
const terminal = { type: 'turn.ended', agentId: 'main', turnId: 0, reason: 'completed' };
const nativePrompt = (turnId) => ({ type: 'turn.prompt', agentId: 'main', turnId, promptId: 'prompt-' + turnId, origin: { kind: 'user' } });
const loop = (event) => ({ type: 'context.append_loop_event', agentId: 'main', event });

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'evolver-kimi-late-terminal-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = join(home, 'project');
  const agent = join(home, 'sessions/workspace/session/agents/main');
  mkdirSync(project);
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(home, 'workspaces.json'), JSON.stringify({ version: 1, workspaces: { workspace: { root: project } } }));
  const wire = join(agent, 'wire.jsonl');
  const add = (...records) => appendFileSync(wire, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  add({ type: 'metadata', protocol_version: '1.5' }, { type: 'profile.bind', agentId: 'main', modelAlias: 'selected', thinkingEffort: 'off' });
  const made = memoryPorts();
  const env = { KIMI_CODE_HOME: home };
  made.ports.model = { capture: () => route };
  made.ports.native = nativeFactsOf(profile.native, env);
  const driver = createDriver({ profile, ports: made.ports, env, lifetime: 'ephemeral', transcripts: { size: () => 0, readSince: () => '' } });
  const payload = { session_id: 'session', cwd: project, client_type: 'kimi_code_cli' };
  const id = profile.payload.sessionId(payload, { env, nativeScope: made.ports.native.scope });
  const call = (event, extra = {}) => driver.handle(event, { ...payload, hook_event_name: event, ...extra }, { onError: error => assert.fail(error) });
  const prompt = (text) => call('UserPromptSubmit', { prompt: [{ type: 'text', text }] });
  return { ...made, add, call, home, id, project, prompt };
}

function addVerifiedWork(f, turnId) {
  const edit = 'edit-' + turnId, check = 'check-' + turnId, final = 'final-' + turnId;
  f.add(
    loop({ type: 'tool.call', uuid: edit, turnId, toolCallId: edit, name: 'Edit', args: { path: 'a.js' } }),
    loop({ type: 'tool.result', parentUuid: edit, toolCallId: edit, result: { output: '', durationMs: 2 } }),
    loop({ type: 'tool.call', uuid: check, turnId, toolCallId: check, name: 'Bash', args: { command: 'npm test' } }),
    loop({ type: 'tool.result', parentUuid: check, toolCallId: check, result: { output: '# pass 1\n# fail 0', durationMs: 2 } }),
    { type: 'llm.request', agentId: 'main', modelAlias: 'selected', thinkingEffort: 'off', model: 'fixture-model', provider: 'openai' },
    loop({ type: 'content.part', uuid: 'answer-' + turnId, turnId, stepUuid: final, part: { type: 'text', text: 'Fixed retries.' } }),
    loop({ type: 'step.end', uuid: final, turnId, finishReason: 'end_turn', providerFinishReason: 'completed' }),
  );
}

async function firstTurn(f) {
  assert.match((await f.prompt(PROMPT)).message, /Evolution Memory/);
  f.add(nativePrompt(0));
  await f.call('TurnStarted', { turn_id: 0, origin_kind: 'user' });
  addVerifiedWork(f, 0);
  await f.call('Stop', { turn_id: 0 });
  assert.equal(f.sessions.get(f.id).open, true);
  assert.equal(f.queued.length, 0);
  return f.sessions.get(f.id).sessionEpoch;
}

for (const timing of ['before the next prompt', 'while the next prompt is captured', 'after the next prompt opens', 'after the next native turn starts']) {
  test('a verified Kimi turn reports and keeps work when its terminal arrives ' + timing, async t => {
    const f = fixture(t);
    const epoch = await firstTurn(f);
    if (timing.startsWith('before')) f.add(terminal);
    f.ports.model.capture = () => nextRoute;
    if (timing.startsWith('while')) {
      const capture = f.ports.model.capture;
      f.ports.model.capture = (...args) => {
        f.ports.model.capture = capture;
        f.add(terminal);
        return capture(...args);
      };
    }
    await f.prompt(nextPrompt);
    if (timing === 'after the next prompt opens') f.add(terminal);
    f.add(nativePrompt(1));
    await f.call('TurnStarted', { turn_id: 1, origin_kind: 'user' });
    if (timing === 'after the next native turn starts') {
      const note = { kind: 'edit', turnId: '1', paths: [join(f.project, 'docs.md')] };
      await f.ports.notes.append(f.id, note);
      f.add(terminal);
      const at = { sessionId: f.id, projectDir: f.project, turn: 1, sessionEpoch: epoch };
      await monitorNativeTurn(f.ports, at, observed => reconcileNativeTurn(f.ports, observed),
        () => assert.fail('the earlier monitor must leave the next turn open'),
        { dir: join(f.home, 'monitor'), sleep: () => assert.fail('the verified terminal is already present') });
      assert.equal(f.queued[0]?.report.outcome, 'success', 'the earlier worker settles without another hook');
      assert.deepEqual(await f.ports.notes.read(f.id), [note]);
    }
    await f.call('Notification', { turn_id: 0 });
    // Recovery and a duplicate notification must leave just one report and one ready work turn.
    await recoverNativeTurns(f.ports);
    await f.call('Notification', { turn_id: 0 });

    assert.deepEqual(f.queued.map(({ report }) => [report.task_id, report.asset_id, report.outcome, report.evidence.check?.passed]),
      [[turnTaskId(taskSessionId(f.ports.identity, f.id), 1), ASSET.asset_id, 'success', true]]);
    const candidate = (await f.ports.candidates.read())[f.id];
    assert.deepEqual(candidate.model, route);
    assert.deepEqual(candidate.turns.map(({ turn, sessionEpoch, finalizationPending }) => [turn, sessionEpoch, finalizationPending]), [[1, epoch, undefined]]);
    assert.ok(candidate.turns[0].steps.some(step => step.kind === 'check' && step.command === 'npm test' && step.failed === false));
    const { turn, turnId, open, prompt, sessionEpoch, native } = f.sessions.get(f.id);
    assert.deepEqual(native.model, nextRoute);
    assert.deepEqual({ turn, turnId, open, prompt, sessionEpoch }, { turn: 2, turnId: '1', open: true, prompt: nextPrompt, sessionEpoch: epoch });
  });
}

test('a late Kimi terminal cannot restore a corrected turn as a candidate', async t => {
  const f = fixture(t);
  const epoch = await firstTurn(f);
  await f.prompt('still failing: ' + PROMPT);
  assert.equal(await f.ports.draftCorrections.has(f.id, 1, epoch), true);
  f.add(nativePrompt(1), terminal);
  await f.call('TurnStarted', { turn_id: 1, origin_kind: 'user' });
  await f.call('Notification', { turn_id: 0 });
  await recoverNativeTurns(f.ports);
  assert.deepEqual(await f.ports.candidates.read(), {});
  assert.equal(f.sessions.get(f.id).turnId, '1');
  assert.equal(f.sessions.get(f.id).open, true);
});

test('late work joins a range without replacing the already settled newer route', async t => {
  const f = fixture(t);
  await firstTurn(f);
  f.ports.model.capture = () => nextRoute;
  await f.prompt(nextPrompt);
  f.add(nativePrompt(1));
  await f.call('TurnStarted', { turn_id: 1, origin_kind: 'user' });
  addVerifiedWork(f, 1);
  f.add({ ...terminal, turnId: 1 });
  await f.call('Notification', { turn_id: 1 });
  assert.deepEqual((await f.ports.candidates.read())[f.id].turns.map(turn => turn.turn), [2]);

  f.add(terminal);
  await recoverNativeTurns(f.ports);
  const candidate = (await f.ports.candidates.read())[f.id];
  assert.deepEqual(candidate.model, nextRoute);
  assert.deepEqual(candidate.turns.map(({ turn, modelBinding }) => [turn, modelBinding]), [[1, route.binding], [2, nextRoute.binding]]);
  assert.equal(candidate.routeConflict, 'route_changed');
  assert.deepEqual(f.queued.map(({ report }) => [report.task_id, report.outcome, report.evidence.check?.passed]),
    [[turnTaskId(taskSessionId(f.ports.identity, f.id), 1), 'success', true]]);
});

test('recovery retains older work when its finalizer overlaps a completed newer turn', async t => {
  const f = fixture(t);
  await firstTurn(f);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const enqueue = f.ports.reports.enqueue;
  const oldTask = turnTaskId(taskSessionId(f.ports.identity, f.id), 1);
  let held = false;
  f.ports.reports.enqueue = async (entries) => {
    if (!held && entries.some(({ report }) => report.task_id === oldTask)) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return enqueue(entries);
  };

  f.add(terminal);
  const finishing = f.call('Notification', { turn_id: 0 });
  try {
    await Promise.race([entered.promise, finishing.then(() => assert.fail('older turn never reached report enqueue'))]);
    f.ports.model.capture = () => nextRoute;
    await f.prompt(nextPrompt);
    f.add(nativePrompt(1));
    await f.call('TurnStarted', { turn_id: 1, origin_kind: 'user' });
    addVerifiedWork(f, 1);
    f.add({ ...terminal, turnId: 1 });
    await f.call('Notification', { turn_id: 1 });
    assert.deepEqual((await f.ports.candidates.read())[f.id].turns.map(turn => turn.turn), [2]);
  } finally {
    release.resolve();
    await finishing;
  }

  await recoverNativeTurns(f.ports);
  const candidate = (await f.ports.candidates.read())[f.id];
  assert.deepEqual(candidate.model, nextRoute);
  assert.deepEqual(candidate.turns.map(({ turn, modelBinding, finalizationPending }) => [turn, modelBinding, finalizationPending]),
    [[1, route.binding, undefined], [2, nextRoute.binding, undefined]]);
  assert.deepEqual(f.queued.map(({ report }) => [report.task_id, report.outcome, report.evidence.check?.passed]), [[oldTask, 'success', true]]);
});
