// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { connectCopilot } from '../../../hosts/copilot/dist/adapter.js';
import { irPromptOf } from '../../../lib/distill/ir-prompt.js';
import { memoryPorts, PROMPT, RECIPE, RECIPE_STEPS } from '../../app/memory-ports.js';

const command = 'node --test fixture-pass.test.cjs';
const answer = 'Bounded Redis retries passed the native check.';
const continuation = 'Continue checking the Redis retries. Run node fixture-hold.cjs.';
const recipeMarker = '[Evolution Memory] Recipe: Stabilise flaky redis connection retries';

async function interactive(t) {
  const { ports, queued, requests } = memoryPorts({ recipes: [RECIPE], stepAssets: RECIPE_STEPS });
  const workingDirectory = join(tmpdir(), 'evolver-copilot-interactive-test');
  const sessionId = randomUUID();
  const invocation = { sessionId };
  const handlers = new Map();
  const allHandlers = [];
  const errors = [];
  let hooks, prior;
  const attached = await connectCopilot(async (registration) => {
    hooks = registration.hooks;
    return {
      sessionId,
      on(type, listener) {
        if (typeof type === 'function') {
          allHandlers.push(type);
          return () => allHandlers.splice(allHandlers.indexOf(type), 1);
        }
        const callbacks = handlers.get(type) ?? [];
        callbacks.push(listener);
        handlers.set(type, callbacks);
        return () => callbacks.splice(callbacks.indexOf(listener), 1);
      },
    };
  }, {
    env: { HOME: workingDirectory, USERPROFILE: workingDirectory, COPILOT_HOME: join(workingDirectory, '.copilot'), EVOLVER_AUTO_DISTILL: 'off' },
    overrides: ports,
    onError: (error) => errors.push(error),
  });
  t.after(async () => {
    await attached.close();
    assert.deepEqual(errors, []);
  });

  async function emit(type, data = {}, earlier = null) {
    const event = earlier ?? { type, id: randomUUID(), parentId: prior ?? null, timestamp: new Date().toISOString(), data };
    prior = event.id;
    for (const handler of [...allHandlers, ...(handlers.get(type) ?? []), ...(handlers.get('*') ?? [])]) await handler(event);
    await attached.idle();
    return event;
  }

  async function transform(prompt) {
    const input = { sessionId, workingDirectory, prompt, timestamp: Date.now() };
    await hooks.onUserPromptSubmitted?.(input, invocation);
    return (await hooks.onUserPromptTransformed({ ...input, transformedPrompt: prompt }, invocation))?.modifiedTransformedPrompt ?? prompt;
  }

  async function candidate() {
    const ranges = Object.values(await ports.candidates.read());
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].turns.length, 1);
    return ranges[0].turns[0];
  }

  await hooks.onSessionStart?.({ sessionId, workingDirectory, timestamp: Date.now() }, invocation);
  return {
    emit, transform, candidate, queued, requests,
    candidates: ports.candidates.read,
    stop: () => hooks.onAgentStop?.({ sessionId, workingDirectory, timestamp: Date.now(), stopReason: 'end_turn', stopHookActive: false }, invocation),
  };
}

async function verificationAttempt(host, exit, { followUp, startFollowUp = false, followUpExit } = {}) {
  const transformedContent = await host.transform(PROMPT);
  assert.ok(transformedContent.includes(recipeMarker), 'the SDK hook passes the Recipe to the model');
  const interactionId = randomUUID(), messageId = randomUUID();
  const testTurn = { interactionId, turnId: '0' };
  const call = { toolCallId: 'call_check', toolName: 'powershell', arguments: { command } };
  await host.emit('user.message', { content: PROMPT, transformedContent, interactionId, messageId, turnId: '0' });
  await host.emit('assistant.turn_start', testTurn);
  await host.emit('assistant.message', { ...testTurn, originatingMessageId: messageId, content: '',
    toolRequests: [{ toolCallId: call.toolCallId, name: call.toolName, arguments: call.arguments }] });
  await host.emit('tool.execution_start', { ...call, turnId: '0' });
  await host.emit('tool.execution_complete', {
    ...testTurn, toolCallId: call.toolCallId, success: true, shellExecution: { exitCode: exit },
    toolTelemetry: { properties: { detached: 'false', executionMode: 'sync' } },
    result: { content: 'Fixture shell output reports exit code 0.' },
  });
  await host.emit('assistant.turn_end', { turnId: '0' });
  if (followUp) {
    const retry = { interactionId, turnId: '1' };
    const requested = { toolCallId: 'call_follow_up', name: 'powershell', arguments: { command: followUp } };
    await host.emit('assistant.turn_start', retry);
    await host.emit('assistant.message', { ...retry, originatingMessageId: messageId, content: '', toolRequests: [requested] });
    if (startFollowUp) {
      await host.emit('tool.execution_start', { toolCallId: requested.toolCallId, toolName: requested.name, arguments: requested.arguments, turnId: '1' });
    }
    if (followUpExit !== undefined) {
      await host.emit('tool.execution_complete', {
        ...retry, toolCallId: requested.toolCallId, success: true, shellExecution: { exitCode: followUpExit },
        toolTelemetry: { properties: { detached: 'false', executionMode: 'sync' } },
      });
    }
    await host.emit('assistant.turn_end', { turnId: '1' });
  }
  const finalTurn = { interactionId, turnId: followUp ? '2' : '1' };
  await host.emit('assistant.turn_start', finalTurn);
  await host.emit('assistant.message', { ...finalTurn, originatingMessageId: messageId, content: answer, toolRequests: [] });
  await host.emit('assistant.turn_end', { turnId: finalTurn.turnId });
  await host.stop();
  assert.deepEqual(host.queued, [], 'the first Stop is still provisional');
  assert.deepEqual(await host.candidates(), {});
}

test('a blocked Copilot Stop followed by Ctrl-C after a passing check queues no report or candidate', async (t) => {
  const host = await interactive(t);
  await verificationAttempt(host, 0);

  const transformedContent = await host.transform(continuation);
  assert.equal(transformedContent, continuation, 'Stop continuation does not recall again');
  assert.equal(host.requests.filter(({ path }) => path === '/recipe/search').length, 1);

  const interactionId = randomUUID();
  const call = { toolCallId: 'call_hold', toolName: 'powershell', arguments: { command: 'node fixture-hold.cjs' } };
  await host.emit('user.message', { content: continuation, transformedContent, interactionId, messageId: randomUUID(), turnId: '0' });
  await host.emit('assistant.turn_start', { interactionId, turnId: '0' });
  await host.emit('assistant.message', { interactionId, turnId: '0', content: '', toolRequests: [call] });
  await host.emit('tool.execution_start', { ...call, turnId: '0' });
  assert.deepEqual(host.queued, []);
  assert.deepEqual(await host.candidates(), {});
  await host.emit('assistant.turn_end', { turnId: '0' });
  await host.emit('abort', { reason: 'user' });
  const settlement = await host.emit('session.idle', { aborted: true });
  await host.emit('session.idle', { aborted: true }, settlement);
  assert.deepEqual(host.queued, []);
  assert.deepEqual(await host.candidates(), {});
});

test('only a completed Copilot session.idle reports the passing check and saves one candidate', async (t) => {
  const host = await interactive(t);
  await verificationAttempt(host, 0);
  const settlement = await host.emit('session.idle', { mode: 'interactive' });
  await host.emit('session.idle', { mode: 'interactive' }, settlement);
  assert.deepEqual(host.queued.map(({ report }) => [report.outcome, report.evidence.check.passed]), [['success', true], ['success', true]]);
  assert.deepEqual((await host.candidate()).steps.map(({ kind, command, exit }) => [kind, command, exit]), [['check', command, 0]]);
});

test('Copilot records the structured exit code even when the tool result says success', async (t) => {
  const host = await interactive(t);
  await verificationAttempt(host, 1);
  await host.emit('session.idle', { mode: 'interactive' });
  assert.deepEqual(host.queued.map(({ report }) => [report.outcome, report.evidence.check.passed]), [['failed', false], ['failed', false]]);
  assert.deepEqual((await host.candidate()).steps.map(({ exit, failed }) => [exit, failed]), [[1, true]]);
});

test('a passing check cannot verify a later Copilot check whose native execution was not observed', async (t) => {
  const host = await interactive(t);
  await verificationAttempt(host, 0, { followUp: 'npm test' });
  await host.emit('session.idle', { mode: 'interactive' });
  assert.equal(host.queued.length, 0, 'a requested check without a receipt cannot report success');
  assert.deepEqual(await host.candidates(), {});
});

test('an earlier pass cannot cover a started Copilot check still missing its exit at idle', async (t) => {
  const host = await interactive(t);
  await verificationAttempt(host, 0, { followUp: 'npm test', startFollowUp: true });
  await host.emit('session.idle', { mode: 'interactive' });
  assert.deepEqual(host.queued, []);
  assert.deepEqual(await host.candidates(), {});
});

test('Copilot records a failed check followed by a successful rerun with both native exits', async (t) => {
  const host = await interactive(t);
  await verificationAttempt(host, 1, { followUp: command, startFollowUp: true, followUpExit: 0 });
  await host.emit('session.idle', { mode: 'interactive' });
  assert.deepEqual(host.queued.map(({ report }) => [report.outcome, report.evidence.check.fail_then_pass]), [['success', true], ['success', true]]);
  assert.deepEqual((await host.candidate()).steps.map(({ exit, failed }) => [exit, failed]), [[1, true], [0, false]]);
});

test('a verification call without a matching Copilot request keeps the interaction unverified', async (t) => {
  const host = await interactive(t);
  await verificationAttempt(host, 0);
  await host.emit('tool.execution_start', {
    toolCallId: 'unmatched_check', toolName: 'powershell', arguments: { command: 'npm test' }, turnId: '1',
  });
  await host.emit('session.idle', { mode: 'interactive' });
  assert.deepEqual(host.queued, []);
  assert.deepEqual(await host.candidates(), {});
});

test('the generated private distillation prompt stays out of Copilot recall even when pasted with its instructions', async (t) => {
  const host = await interactive(t);
  const prompt = irPromptOf({
    kind: 'investigate',
    focus: 'Keep the local fixture evidence private',
    record: [{ kind: 'check', text: 'node --test private-fixture-path.cjs', exit: 0 }],
  });
  for (const input of [prompt, `Copy the following IR prompt.\n\n${prompt}`]) {
    assert.equal(await host.transform(input), input);
    await host.emit('session.idle', { mode: 'interactive' });
  }
  assert.deepEqual(host.requests.filter(({ path }) => ['/recipe/search', '/asset/fetch'].includes(path)), []);
  assert.deepEqual(host.queued, []);
  assert.deepEqual(await host.candidates(), {});
  assert.match(await host.transform(PROMPT), /\[Evolution Memory\] Recipe:/);
});
