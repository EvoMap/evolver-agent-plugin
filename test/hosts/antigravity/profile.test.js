import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import profile from '../../../hosts/antigravity/profile.js';
import { ownerProbeOf } from '../../../lib/runtime/process/owner.js';

const payloads = JSON.parse(readFileSync(new URL('../../fixtures/antigravity/payloads.json', import.meta.url), 'utf8'));
const STRATEGY = '[Evolution Memory] Fix flaky Redis connection retries:\n1. Run npm test\n\nApply them where they fit.';

test('a strategy reaches the model as an ephemeral step before the call, and only from PreInvocation', () => {
  assert.deepEqual(profile.reply.context(STRATEGY, 'PreInvocation'), { injectSteps: [{ ephemeralMessage: STRATEGY }] });
  assert.deepEqual(profile.reply.context('', 'PreInvocation'), {});
  assert.deepEqual(profile.reply.notice('[Evolver] set up', 'PreInvocation'), { injectSteps: [{ ephemeralMessage: '[Evolver] set up' }] });
  assert.equal(profile.reply.lifetime, 'call');
});

test('PreToolUse and Stop always answer the decision they require, never an empty object', () => {
  assert.deepEqual(profile.reply.empty('PreToolUse'), { decision: 'allow' });
  assert.deepEqual(profile.reply.empty('Stop'), { decision: 'stop' });
  assert.deepEqual(profile.reply.context(STRATEGY, 'Stop'), { decision: 'stop' });
  assert.deepEqual(profile.reply.turnEnd({ turn: 1, reports: [] }, 'Stop'), { decision: 'stop' });
  assert.deepEqual(profile.reply.empty('PreInvocation'), {});
});

test('commands are typed in a terminal: the command script prints the text, in a conversation when one is named', () => {
  assert.equal(profile.commands.entry, 'cli-only');
  assert.equal(profile.commands.scriptAnswer({ ok: true, text: 'Proxy running.' }, {}), 'Proxy running.');
  assert.equal(profile.commands.sessionOf({}), null);
  assert.equal(profile.commands.sessionOf({ ANTIGRAVITY_CONVERSATION_ID: 'c1' }), 'c1');
});

test('the session belongs to the nearest agy or language_server above the hook, past its shell', () => {
  const table = new Map([[process.ppid, { ppid: 60, name: 'sh' }], [60, { ppid: 50, name: 'language_server_macos_arm' }], [50, { ppid: 1, name: 'agy' }]]);
  const probe = (pid) => table.get(pid) ?? null;
  assert.equal(ownerProbeOf(profile.owner, { probe, platform: 'darwin' }).current(), 60);
  const cli = new Map([[process.ppid, { ppid: 50, name: 'node' }], [50, { ppid: 1, name: 'agy' }]]);
  assert.equal(ownerProbeOf(profile.owner, { probe: (pid) => cli.get(pid) ?? null, platform: 'linux' }).current(), 50);
  assert.equal(ownerProbeOf(profile.owner, { probe: () => null, platform: 'darwin' }).current(), null);
  assert.equal(profile.sessionStart, 'owner-change');
});

test('the headless model is agy on the session\'s model, the prompt one stream-json user event on stdin', () => {
  const { model } = profile;
  assert.equal(model.kind, 'cli');
  assert.equal(model.command({}), 'agy');
  assert.deepEqual(model.args(profile.payload.model(payloads.Stop)), ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands', '--model', 'gemini-3.6-flash-medium']);
  assert.deepEqual(JSON.parse(model.input('## Task\nadd a retry')), { event: 'user', message: { content: '## Task\nadd a retry' } });
  assert.ok(model.input('x').endsWith('\n'));
  assert.equal(model.workdir, 'empty');
});

test('the answer is the run\'s result event with its token usage; any other status throws its reason', () => {
  const usage = { input_tokens: 900, output_tokens: 120, thinking_tokens: 30, cache_read_tokens: 5, total_tokens: 1055 };
  const events = (result) => [
    { event: 'init', conversation_id: 'c-headless', init: { cwd: '/tmp/x', tools: ['run_command'] } },
    { event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: '{"summary":"s"}' } },
    { event: 'result', result },
  ].map((event) => JSON.stringify(event)).join('\n');
  const answer = profile.model.parse({ stdout: events({ status: 'SUCCESS', response: '{"summary":"s"}\n', usage }), stderr: '' });
  assert.deepEqual(answer, { answer: '{"summary":"s"}\n', usage: { inputTokens: 900, cachedInputTokens: 5, outputTokens: 120, reasoningOutputTokens: 30 } });
  assert.throws(() => profile.model.parse({ stdout: events({ status: 'ERROR', response: '', error: 'Authentication required' }), stderr: '' }), /agy ERROR: Authentication required/);
  assert.throws(() => profile.model.parse({ stdout: '', stderr: 'unknown model' }), /agy failed: unknown model/);
});
