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

async function interactive(t, expectedErrors = []) {
  const { ports, queued, requests } = memoryPorts({ recipes: [RECIPE], stepAssets: RECIPE_STEPS });
  const workingDirectory = join(tmpdir(), 'evolver-copilot-interactive-test');
  const sessionId = randomUUID();
  const invocation = { sessionId };
  const handlers = new Map();
  const allHandlers = [];
  const errors = [];
  let hooks, prior, unsubscribes = 0;
  const attached = await connectCopilot(async (registration) => {
    hooks = registration.hooks;
    return {
      sessionId,
      on(type, listener) {
        if (typeof type === 'function') {
          allHandlers.push(type);
          return () => { unsubscribes++; allHandlers.splice(allHandlers.indexOf(type), 1); };
        }
        const callbacks = handlers.get(type) ?? [];
        callbacks.push(listener);
        handlers.set(type, callbacks);
        return () => { unsubscribes++; callbacks.splice(callbacks.indexOf(listener), 1); };
      },
    };
  }, {
    env: { HOME: workingDirectory, USERPROFILE: workingDirectory, COPILOT_HOME: join(workingDirectory, '.copilot'), EVOLVER_AUTO_DISTILL: 'off' },
    overrides: ports,
    onError: (error) => errors.push(error),
  });
  t.after(async () => {
    await attached.close();
    assert.deepEqual(errors, expectedErrors);
  });

  async function emit(type, data = {}, earlier = null) {
    const event = earlier ?? { type, id: randomUUID(), parentId: prior ?? null, timestamp: new Date().toISOString(), data };
    prior = event.id;
    for (const handler of [...allHandlers, ...(handlers.get(type) ?? []), ...(handlers.get('*') ?? [])]) await handler(event);
    await attached.idle();
    return event;
  }

  async function transform(prompt, { timestamp = Date.now() } = {}) {
    const input = { sessionId, workingDirectory, prompt, timestamp };
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
    emit, transform, candidate, queued, requests, ports, sessionId,
    close: () => attached.close(),
    unsubscribeCount: () => unsubscribes,
    candidates: ports.candidates.read,
    end: (input = {}, invoked = invocation) => hooks.onSessionEnd?.({ sessionId, workingDirectory, timestamp: new Date(), reason: 'user_exit', ...input }, invoked),
    stop: () => hooks.onAgentStop?.({ sessionId, workingDirectory, timestamp: Date.now(), stopReason: 'end_turn', stopHookActive: false }, invocation),
  };
}

async function verificationAttempt(host, exit, { followUp, startFollowUp = false, followUpExit, check = command,
  output = 'Fixture shell output reports exit code 0.', timestamp = Date.now() } = {}) {
  const transformedContent = await host.transform(PROMPT, { timestamp });
  assert.ok(transformedContent.includes(recipeMarker), 'the SDK hook passes the Recipe to the model');
  const interactionId = randomUUID(), messageId = randomUUID();
  const testTurn = { interactionId, turnId: '0' };
  const call = { toolCallId: 'call_check', toolName: 'powershell', arguments: { command: check } };
  await host.emit('user.message', { content: PROMPT, transformedContent, interactionId, messageId, turnId: '0' });
  await host.emit('assistant.turn_start', testTurn);
  await host.emit('assistant.message', { ...testTurn, originatingMessageId: messageId, content: '',
    toolRequests: [{ toolCallId: call.toolCallId, name: call.toolName, arguments: call.arguments }] });
  await host.emit('tool.execution_start', { ...call, turnId: '0' });
  await host.emit('tool.execution_complete', {
    ...testTurn, toolCallId: call.toolCallId, success: true, shellExecution: { exitCode: exit },
    toolTelemetry: { properties: { detached: 'false', executionMode: 'sync' } },
    result: { content: output },
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
  const outcomes = () => host.queued.map(({ report }) => [report.asset_id, report.outcome, report.evidence.check.passed]);
  const expected = [['sha256:step1', 'success', true], ['sha256:step2', 'success', true]];
  assert.deepEqual(outcomes(), expected);
  await host.emit('session.idle', { mode: 'interactive' }, settlement);
  assert.deepEqual(outcomes(), expected, 'replaying idle adds no report');
  assert.deepEqual((await host.candidate()).steps.map(({ kind, command, exit }) => [kind, command, exit]), [['check', command, 0]]);
});

test('Copilot idle retries a candidate write without losing the terminal evidence or repeating the reports', async (t) => {
  const failure = Object.assign(new Error('fixture candidate write refused'), { code: 'EIO' });
  const host = await interactive(t, [failure]);
  await verificationAttempt(host, 0);
  const update = host.ports.candidates.update;
  let refused = false;
  host.ports.candidates.update = async (...args) => {
    if (!refused) {
      refused = true;
      throw failure;
    }
    return update(...args);
  };
  const settlement = await host.emit('session.idle', { mode: 'interactive' });
  assert.deepEqual((await host.candidate()).steps.map(({ kind, command, exit }) => [kind, command, exit]), [['check', command, 0]]);
  await host.emit('session.idle', { mode: 'interactive' }, settlement);
  assert.deepEqual(host.queued.map(({ report }) => [report.outcome, report.evidence.check.passed]), [['success', true], ['success', true]]);
  assert.deepEqual((await host.candidate()).steps.map(({ exit }) => exit), [0]);
});

test('Copilot settles pending evidence before the next prompt and a replayed idle leaves that new turn open', async (t) => {
  const failure = new Error('fixture candidate write refused');
  const host = await interactive(t, [failure, failure]);
  await verificationAttempt(host, 0);
  const update = host.ports.candidates.update;
  let writable = false;
  host.ports.candidates.update = async (...args) => {
    if (!writable) throw failure;
    return update(...args);
  };
  const completed = await host.emit('session.idle');
  assert.deepEqual(await host.candidates(), {});

  writable = true;
  await host.transform('Explain the retry budget in a new turn.');
  assert.deepEqual((await host.candidate()).steps.map(({ exit }) => exit), [0]);
  await host.emit('session.idle', {}, completed);
  const next = await host.ports.sessions.read(host.sessionId);
  assert.equal(next.turn, 2);
  assert.equal(next.open, true);
  await host.emit('abort', { reason: 'user' });
  await host.emit('session.idle', { aborted: true });
  assert.deepEqual((await host.candidate()).steps.map(({ exit }) => exit), [0]);
  assert.equal(host.queued.length, 2);
});

test('a failed Copilot close keeps pending terminal evidence retryable after storage recovers', async (t) => {
  const failure = new Error('fixture candidate write refused during shutdown');
  const host = await interactive(t, [failure, failure, failure, failure]);
  await verificationAttempt(host, 0);
  const update = host.ports.candidates.update;
  let writable = false;
  host.ports.candidates.update = async (...args) => {
    if (!writable) throw failure;
    return update(...args);
  };
  await host.emit('session.idle');
  assert.deepEqual(await host.candidates(), {});
  await assert.rejects(host.close(), /could not persist.*retry/i);
  writable = true;
  await host.close();
  assert.deepEqual((await host.candidate()).steps.map(({ exit }) => exit), [0]);
  assert.equal(host.queued.length, 2, 'retrying close must not duplicate reports');
  assert.equal((await host.ports.sessions.read(host.sessionId)).open, false);
  assert.equal(Object.values(await host.candidates())[0].closed, true);
});

test('a failed Copilot session-end write keeps close retryable', async (t) => {
  const failure = new Error('fixture session-end write refused');
  const host = await interactive(t, [failure]);
  await verificationAttempt(host, 0);
  await host.emit('session.idle');
  const enqueue = host.ports.reports.enqueue;
  let writable = false;
  host.ports.reports.enqueue = async (...args) => {
    if (!writable) throw failure;
    return enqueue(...args);
  };
  await assert.rejects(host.close(), /could not persist.*retry/i);
  writable = true;
  await host.close();
  assert.equal(host.queued.length, 2);
  assert.equal((await host.ports.sessions.read(host.sessionId)).open, false);
  assert.equal(Object.values(await host.candidates())[0].closed, true);
});

test('concurrent Copilot close calls unsubscribe only once', async (t) => {
  const host = await interactive(t);
  await verificationAttempt(host, 0);
  await host.emit('session.idle');
  await Promise.all([host.close(), host.close()]);
  assert.equal(host.unsubscribeCount(), 1);
  assert.equal(Object.values(await host.candidates())[0].closed, true);
  assert.equal(host.queued.length, 2);
});

test('Copilot native session-end and shutdown retry pending terminal evidence after storage recovers', async (t) => {
  const failure = new Error('fixture native shutdown write refused');
  const host = await interactive(t, [failure, failure, failure, failure]);
  await verificationAttempt(host, 0);
  const update = host.ports.candidates.update;
  let writable = false;
  host.ports.candidates.update = async (...args) => {
    if (!writable) throw failure;
    return update(...args);
  };
  await host.emit('session.idle');
  await host.end();
  assert.deepEqual(await host.candidates(), {});
  writable = true;
  await host.emit('session.shutdown');
  assert.deepEqual((await host.candidate()).steps.map(({ exit }) => exit), [0]);
  assert.equal(host.queued.length, 2);
  assert.equal(Object.values(await host.candidates())[0].closed, true);
});

test('Copilot native shutdown retries a failed session-end write', async (t) => {
  const failure = new Error('fixture native session-end write refused');
  const host = await interactive(t, [failure]);
  await verificationAttempt(host, 0);
  await host.emit('session.idle');
  const enqueue = host.ports.reports.enqueue;
  let writable = false;
  host.ports.reports.enqueue = async (...args) => {
    if (!writable) throw failure;
    return enqueue(...args);
  };
  await host.end();
  assert.notEqual(Object.values(await host.candidates())[0].closed, true);
  writable = true;
  await host.emit('session.shutdown');
  assert.equal(Object.values(await host.candidates())[0].closed, true);
  assert.equal(host.queued.length, 2);
});

test('Copilot fences stale native terminal events when the SDK supplies a Date prompt timestamp', async (t) => {
  const host = await interactive(t);
  await verificationAttempt(host, 0, { timestamp: new Date() });
  for (const type of ['session.idle', 'abort', 'session.shutdown']) {
    await host.emit(type, {}, { type, id: randomUUID(), timestamp: '2026-01-01T00:00:00Z', data: {} });
  }
  assert.equal((await host.ports.sessions.read(host.sessionId)).open, true);
  assert.deepEqual(host.queued, []);
  assert.deepEqual(await host.candidates(), {});
  await host.emit('session.idle');
  assert.equal(host.queued.length, 2, 'a current native idle still settles the valid check');
});

test('Copilot rejects stale shutdown even after its current turn has settled', async (t) => {
  const host = await interactive(t);
  await verificationAttempt(host, 0);
  await host.emit('session.idle');
  await host.emit('session.shutdown', {}, { type: 'session.shutdown', id: randomUUID(), timestamp: '2026-01-01T00:00:00Z', data: {} });
  assert.match(await host.transform(PROMPT), /\[Evolution Memory\]/);
  assert.equal(host.requests.filter(({ path }) => path === '/recipe/search').length, 2);
});

test('Copilot cannot settle a verified turn from a missing or malformed terminal timestamp', async (t) => {
  const host = await interactive(t);
  await verificationAttempt(host, 0);
  for (const type of ['session.idle', 'abort', 'session.shutdown']) {
    for (const timestamp of [undefined, 'invalid timestamp', 42]) {
      await host.emit(type, {}, { type, id: randomUUID(), timestamp, data: {} });
    }
  }
  assert.equal((await host.ports.sessions.read(host.sessionId)).open, true);
  assert.deepEqual(host.queued, []);
  assert.deepEqual(await host.candidates(), {});
  await host.emit('abort', { reason: 'user' });
  await host.emit('session.idle', { aborted: true });
  assert.deepEqual(host.queued, []);
  assert.deepEqual(await host.candidates(), {});
});

test('a Copilot session-end hook explicitly naming another session cannot close the current turn', async (t) => {
  const host = await interactive(t);
  await verificationAttempt(host, 0);
  await host.end({ sessionId: 'another-session' });
  await host.end({}, { sessionId: 'another-session' });
  assert.equal((await host.ports.sessions.read(host.sessionId)).open, true);
  assert.deepEqual(host.queued, []);
  assert.deepEqual(await host.candidates(), {});
  await host.emit('session.idle');
  assert.equal(host.queued.length, 2);
});

test('Copilot rejects invalid prompt timestamps without creating a session turn', async (t) => {
  const host = await interactive(t);
  for (const timestamp of [NaN, new Date(NaN)]) assert.equal(await host.transform(PROMPT, { timestamp }), PROMPT);
  assert.equal(host.requests.filter(({ path }) => path === '/recipe/search').length, 0);
  assert.match(await host.transform(PROMPT, { timestamp: new Date() }), /\[Evolution Memory\] Recipe:/);
});

test('Copilot default persistence diagnostics never include the thrown private error text', async (t) => {
  const { ports } = memoryPorts({ recipes: [RECIPE], stepAssets: RECIPE_STEPS });
  const update = ports.sessions.update;
  let first = true, hooks, diagnostic = '';
  ports.sessions.update = async (...args) => {
    if (first) { first = false; throw new Error('opaqueFixtureDiagnosticSecret'); }
    return update(...args);
  };
  t.mock.method(process.stderr, 'write', (text) => { diagnostic += text; return true; });
  const sessionId = randomUUID(), workingDirectory = tmpdir();
  const attached = await connectCopilot(async (registration) => {
    hooks = registration.hooks;
    return { sessionId, on: () => () => {} };
  }, { env: { HOME: workingDirectory, USERPROFILE: workingDirectory, EVOLVER_AUTO_DISTILL: 'off' }, overrides: ports });
  t.after(() => attached.close());
  await hooks.onUserPromptTransformed({ sessionId, workingDirectory, prompt: PROMPT, transformedPrompt: PROMPT, timestamp: Date.now() });
  assert.match(diagnostic, /Evolver.*Copilot.*unconfirmed/);
  assert.doesNotMatch(diagnostic, /opaqueFixtureDiagnosticSecret/);
});

test('an old Copilot idle stays stale after its ID leaves the deduplication window', async (t) => {
  const host = await interactive(t);
  await verificationAttempt(host, 0);
  const stale = { type: 'session.idle', id: randomUUID(), timestamp: '2026-01-01T00:00:00Z', data: { mode: 'interactive' } };
  // First observe idle with no work after processing the normal terminal event.
  await host.emit('session.idle', { mode: 'interactive' });
  await host.emit(stale.type, stale.data, stale);
  for (let index = 0; index < 4096; index++) await host.emit('assistant.turn_end', { turnId: '1' });
  await host.transform('Explain the retry budget in a new turn.');
  await host.emit(stale.type, stale.data, stale);
  assert.equal((await host.ports.sessions.read(host.sessionId)).open, true);
  assert.equal(host.queued.length, 2);
});

test('Copilot records the structured exit code even when the tool result says success', async (t) => {
  const host = await interactive(t);
  await verificationAttempt(host, 1);
  await host.emit('session.idle', { mode: 'interactive' });
  assert.deepEqual(host.queued.map(({ report }) => [report.outcome, report.evidence.check.passed]), [['failed', false], ['failed', false]]);
  assert.deepEqual((await host.candidate()).steps.map(({ exit, failed }) => [exit, failed]), [[1, true]]);
});

test('redacting an unquoted Cookie argument leaves the Copilot check eligible for reuse', async (t) => {
  const host = await interactive(t);
  const suffix = ' https://example.test && npm test';
  await verificationAttempt(host, 0, {
    check: 'curl -H Cookie:sid=opaqueFixtureSession' + suffix,
    output: '# pass 3\n# fail 0',
  });
  await host.emit('session.idle');
  assert.deepEqual(host.queued.map(({ report }) => report.outcome), ['success', 'success']);
  assert.deepEqual((await host.candidate()).steps.map(({ command, exit, failed }) => [command, exit, failed]),
    [['curl -H [redacted]' + suffix, null, false]]);
});

test('a delayed Copilot prompt does not reopen a shut-down native session', async (t) => {
  const host = await interactive(t);
  await verificationAttempt(host, 0);
  await host.emit('session.idle');
  await host.emit('session.shutdown');

  const late = 'Continue the Redis retries work after shutdown.';
  assert.equal(await host.transform(late), late);
  assert.equal(host.requests.filter(({ path }) => path === '/recipe/search').length, 1);
  assert.equal((await host.ports.sessions.read(host.sessionId)).open, false);
  assert.equal(host.queued.length, 2);
});

test('Copilot redacts a long cookie before keeping the tail of failed check output', async (t) => {
  const host = await interactive(t);
  const credential = 'opaqueFixtureCookie'.repeat(150);
  await verificationAttempt(host, 1, { output: `Cookie: sid=${credential}\nVerification failed.` });
  await host.emit('session.idle', { mode: 'interactive' });
  const [step] = (await host.candidate()).steps;
  assert.equal(step.output.includes('opaqueFixtureCookie'), false);
  assert.match(step.output, /Verification failed\./);
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
