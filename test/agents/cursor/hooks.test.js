import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ASSET, PROMPT } from '../../app/memory-ports.js';
import { fakeProxy } from '../../helpers/fake-proxy.js';

const PASSED_RUN = 'ℹ tests 2\nℹ pass 2\nℹ fail 0\n';
const FAILED_RUN = 'not ok 1 - retries\nAssertionError: expected 1 to equal 2\n';
const TURN_TOKENS = { input_tokens: 30_000, output_tokens: 2_000, cache_read_tokens: 50_000, cache_write_tokens: 1_000 };
const HOOK = fileURLToPath(new URL('../../../bin/hook.mjs', import.meta.url));

const SECOND_ASSET = { ...ASSET, asset_id: `sha256:${'b'.repeat(64)}`, short_title: 'Stabilise flaky redis retries in integration tests' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let proxy;
beforeEach(async () => { proxy = await fakeProxy(); });

// A detached worker may still be writing into the scratch home when a test ends.
afterEach(async () => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return proxy.close();
    } catch (error) {
      if (attempt === 20) throw error;
      await sleep(100);
    }
  }
});

// Each hook is its own process, as Cursor runs it: the prompt hook's recall wait spans its 660 s budget, which only
// the process's exit ends.
function hook(hostEvent, payload, env = proxy.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, 'cursor', hostEvent], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    let written = '';
    child.stdout.on('data', (chunk) => { written += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(written)) : reject(new Error(`hook exited ${code}`))));
    child.stdin.end(JSON.stringify(payload));
  });
}

const statePath = (name) => join(proxy.env.HOME, '.evolver', 'state', name);
const reuseReports = () => proxy.requests.filter((request) => request.path === '/asset/reuse-result').map((request) => request.body);
const fetches = () => proxy.requests.filter((request) => request.path === '/asset/fetch');
const candidates = () => (existsSync(statePath('cursor-distill-pending.json')) ? JSON.parse(readFileSync(statePath('cursor-distill-pending.json'), 'utf8')) : {});

async function waitFor(read, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if ((Array.isArray(value) ? value.length > 0 : value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function chat(id, env) {
  const project = join(proxy.env.HOME, 'project');
  mkdirSync(project, { recursive: true });
  const base = { conversation_id: id, session_id: id, model: 'claude-4.5-sonnet', workspace_roots: [project], cursor_version: '3.27.6' };
  let turn = 0;
  const generation = () => `${id}-gen-${turn}`;
  const send = (event, fields) => hook(event, { ...base, generation_id: generation(), hook_event_name: event, ...fields }, env);
  const tool = (name, input) => ({ tool_name: name, tool_input: input, tool_use_id: `call-${Math.random()}`, cwd: project });
  return {
    generation,
    start: () => hook('sessionStart', { ...base, generation_id: '', hook_event_name: 'sessionStart', is_background_agent: false, composer_mode: 'agent' }, env),
    prompt: (prompt, { sameTurn = false, composerMode = 'agent' } = {}) => {
      if (!sameTurn) turn += 1;
      return send('beforeSubmitPrompt', { prompt, attachments: [], ...(composerMode && { composer_mode: composerMode }) });
    },
    shell: (command, output, exitCode = 0) => send('postToolUse', { ...tool('Shell', { command, cwd: project }), tool_output: JSON.stringify({ output, exitCode }) }),
    shellFailed: (command, message, failureType = 'error', interrupted = false) => send('postToolUseFailure', {
      ...tool('Shell', { command, cwd: project }), error_message: message, failure_type: failureType, is_interrupt: interrupted,
    }),
    write: async (file, content) => {
      const target = join(project, file);
      await send('preToolUse', tool('Write', { file_path: target, content }));
      writeFileSync(target, content);
      await send('postToolUse', { ...tool('Write', { file_path: target, content }), tool_output: JSON.stringify({ file_path: target, success: true }) });
      await send('afterFileEdit', { file_path: target, edits: [{ old_string: '', new_string: content }] });
    },
    answer: (text) => send('afterAgentResponse', { text }),
    stop: (status = 'completed') => send('stop', { status, loop_count: 0, ...TURN_TOKENS }),
    end: (reason = 'user_close') => send('sessionEnd', { reason, duration_ms: 1000, is_background_agent: false, final_status: 'completed' }),
  };
}

async function fixTurn(c) {
  const injected = await c.prompt(PROMPT);
  await c.write('redis.js', 'export const retries = null;\n');
  await c.shell('npm test', FAILED_RUN, 1);
  await c.shell('npm test 2>&1 | tail -5', PASSED_RUN);
  await c.answer('Retries fixed; npm test passes.');
  await c.stop();
  return injected;
}

test('a recalled strategy rides beforeSubmitPrompt as additional_context with continue, recalled by the prompt text', async () => {
  const answer = await chat('s-recall').prompt(PROMPT);
  assert.equal(answer.continue, true);
  assert.match(answer.additional_context, new RegExp(`^\\[Evolution Memory\\] ${ASSET.short_title}`));
  assert.ok(answer.additional_context.endsWith('Apply them where they fit.'));
  assert.doesNotMatch(answer.additional_context, /evolver_/);
  assert.equal(fetches().length, 1);
});

test('an inline edit, which names no composer_mode, is neither recalled for nor recorded', async () => {
  const c = chat('s-inline');
  assert.deepEqual(await c.prompt(PROMPT, { composerMode: null }), {});
  assert.deepEqual(await c.stop(), {});
  assert.deepEqual(fetches(), []);
  assert.equal(existsSync(statePath('cursor-reports-queue.jsonl')), false);
});

test("the stop reports the strategy with the turn's own checks: an exit code fails one, a later pass after a failure is fail-then-pass", async () => {
  await fixTurn(chat('s-fix'));
  const [report] = await waitFor(reuseReports);
  assert.equal(report.task_id, 'cursor:s-fix:1');
  assert.equal(report.asset_id, ASSET.asset_id);
  assert.equal(report.outcome, 'success');
  assert.deepEqual(report.evidence.check, { kind: 'test', passed: true, fail_then_pass: true });
  assert.equal(report.evidence.tier, 'L1');
  assert.equal(report.evidence.aborted, false);
});

test('a timed-out check fails; an interrupted, backgrounded or denied one is no evidence', async () => {
  const timedOut = chat('s-timeout');
  await timedOut.prompt(PROMPT);
  await timedOut.shellFailed('npm test', 'Command timed out after 30000ms', 'timeout');
  await timedOut.stop();
  const cut = chat('s-cut');
  await cut.prompt(PROMPT);
  await cut.shellFailed('npm test', 'Command was aborted', 'error', true);
  await cut.shellFailed('npm test', 'Unknown error');
  await cut.shellFailed('npm test', 'denied', 'permission_denied');
  await cut.stop();
  const reports = await waitFor(() => (reuseReports().length >= 2 ? reuseReports() : []));
  assert.equal(reports.find((report) => report.task_id === 'cursor:s-timeout:1').evidence.check.passed, false);
  assert.equal(reports.find((report) => report.task_id === 'cursor:s-cut:1').evidence.check, undefined);
});

test('each stop status is the turn-end reason: aborted is marked aborted, error reports failed', async () => {
  const cut = chat('s-aborted');
  await cut.prompt(PROMPT);
  await cut.shell('npm test', PASSED_RUN);
  await cut.stop('aborted');
  const failed = chat('s-errored');
  await failed.prompt(PROMPT);
  await failed.stop('error');
  const reports = await waitFor(() => (reuseReports().length >= 2 ? reuseReports() : []));
  const aborted = reports.find((report) => report.task_id === 'cursor:s-aborted:1');
  assert.equal(aborted.evidence.aborted, true);
  assert.equal(aborted.outcome, 'success', 'the check that passed still decides the outcome');
  assert.equal(reports.find((report) => report.task_id === 'cursor:s-errored:1').outcome, 'failed');
  assert.deepEqual(candidates(), {});
});

test('a correction in the next prompt sends an L3 follow-up under :correction', async () => {
  const c = chat('s-correct');
  await fixTurn(c);
  await waitFor(reuseReports);
  await c.prompt('还是报错，不对');
  const correction = await waitFor(() => reuseReports().find((report) => report.task_id.endsWith(':correction')));
  assert.equal(correction.task_id, 'cursor:s-correct:1:correction');
  assert.equal(correction.outcome, 'failed');
  assert.equal(correction.evidence.tier, 'L3');
});

test('a turn whose stop never came is closed as an error when the next prompt arrives, after the settle wait', async () => {
  const c = chat('s-nostop');
  await c.prompt(PROMPT);
  const startedAt = Date.now();
  await c.prompt('continue with the README');
  assert.ok(Date.now() - startedAt >= 3_000, 'the prompt waited for a stop still on its way');
  const [report] = await waitFor(reuseReports);
  assert.equal(report.task_id, 'cursor:s-nostop:1');
  assert.equal(report.outcome, 'failed');
  assert.equal(report.evidence.aborted, false);
});

test('a late stop of an earlier turn closes nothing of the current one, and a resubmitted generation opens no new turn', async () => {
  const c = chat('s-late');
  await c.prompt(PROMPT);
  const firstGeneration = c.generation();
  await c.stop();
  const second = await c.prompt('add a test for the flaky redis connection retries');
  await hook('stop', { conversation_id: 's-late', generation_id: firstGeneration, hook_event_name: 'stop', status: 'completed' });
  assert.deepEqual(await c.prompt('add a test for the flaky redis connection retries', { sameTurn: true }), second);
  await c.stop();
  await waitFor(reuseReports);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(reuseReports().map((report) => report.task_id), ['cursor:s-late:1']);
  assert.equal(fetches().length, 2, 'the resubmitted generation was not recalled for again');
});

test('a chat closed while its turn runs reports the strategy aborted, once', async () => {
  const c = chat('s-gone');
  await c.prompt(PROMPT);
  await c.end('window_close');
  await c.stop('aborted');
  const [report] = await waitFor(reuseReports);
  assert.equal(report.task_id, 'cursor:s-gone:1');
  assert.deepEqual(report.evidence, { tier: 'none', applied: 'used', aborted: true, stage: 'immediate' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(reuseReports().length, 1);
});

test('a reopened chat keeps counting turns after its session end, so task ids never repeat', async () => {
  proxy.close();
  proxy = await fakeProxy({ assets: [ASSET, SECOND_ASSET] });
  const c = chat('s-resume');
  await c.prompt(PROMPT);
  await c.stop();
  await c.end();
  await c.prompt('fix the flaky redis connection retries in the integration tests too');
  await c.stop();
  const reports = await waitFor(() => (reuseReports().length >= 2 ? reuseReports() : []));
  assert.deepEqual(reports.map((report) => report.task_id).sort(), ['cursor:s-resume:1', 'cursor:s-resume:2']);
});

test('a typed plugin command is answered by the hook and stops the prompt before any model sees it', async () => {
  const c = chat('s-commands');
  const status = await c.prompt('/evolver-status');
  assert.equal(status.continue, false);
  assert.match(status.user_message, /node_test/);
  assert.match((await c.prompt('/evolver-distill')).user_message, /^Nothing to distill yet/);
  assert.match((await c.prompt('/evolver-drafts')).user_message, /^No distilled drafts are waiting/);
  assert.deepEqual(fetches(), [], 'a command recalls nothing');
});

test('/evolver-evolve is passed on to the agent as a prompt, with its focus', async () => {
  const answer = await chat('s-evolve').prompt('/evolver-evolve the retry policy');
  assert.equal(answer.continue, true);
  assert.match(answer.additional_context, /^Take a deliberate evolution step/);
  assert.ok(answer.additional_context.endsWith('Focus on: the retry policy'));
});

test('every other hook answers an empty JSON object', async () => {
  const c = chat('s-json');
  assert.deepEqual(await c.start(), {});
  await c.prompt(PROMPT);
  assert.deepEqual(await c.shell('npm test', PASSED_RUN), {});
  assert.deepEqual(await c.shellFailed('npm test', FAILED_RUN), {});
  assert.deepEqual(await c.answer('done'), {});
  assert.deepEqual(await c.stop(), {});
  assert.deepEqual(await c.end(), {});
});

test('inside the headless distillation every hook does nothing', async () => {
  const c = chat('s-headless', { ...proxy.env, EVOLVER_HEADLESS: '1' });
  assert.deepEqual(await c.start(), {});
  assert.deepEqual(await c.prompt(PROMPT), {});
  await c.shell('npm test', PASSED_RUN);
  await c.stop();
  await c.end();
  assert.deepEqual(proxy.requests, []);
  assert.equal(existsSync(statePath('')), false);
});

test('a verified turn becomes the chat candidate with its final answer', { todo: 'lib/turn/record.js must read the afterAgentResponse answer note' }, async () => {
  await fixTurn(chat('s-candidate'));
  const candidate = candidates()['s-candidate'];
  assert.equal(candidate?.answer, 'Retries fixed; npm test passes.');
  assert.deepEqual(candidate?.model, { model: 'claude-4.5-sonnet' });
});

test('session start tells the engine notice once, as additional_context', { todo: 'lib/agent/driver.js sessionStart drops the payload, so the notice never reaches the reply' }, async () => {
  mkdirSync(statePath(''), { recursive: true });
  writeFileSync(statePath('cursor-engine.json'), JSON.stringify({ status: 'started', version: '2.0.46', at: 1 }));
  const answer = await chat('s-notice').start();
  assert.match(answer.additional_context ?? '', /^\[Evolver\]/);
});
