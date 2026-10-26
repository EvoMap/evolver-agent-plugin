import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import profile from '../../../agents/workbuddy/profile.js';
import { SCRIPT_EVENTS } from '../../../lib/channels/script/runner.js';

const PAYLOADS = JSON.parse(readFileSync(new URL('../../fixtures/workbuddy/hook-payloads.json', import.meta.url), 'utf8'));
const parse = (prompt, hostEvent = 'UserPromptSubmit') => profile.commands.parse({}, hostEvent, { prompt });
const RESULT = { type: 'result', subtype: 'success', is_error: false, result: '{"summary":"s"}', usage: { input_tokens: 900, output_tokens: 120 } };

test('commands are inline scripts: the command script raises the two events the profile maps', () => {
  assert.equal(profile.commands.entry, 'inline-script');
  assert.equal(profile.events[SCRIPT_EVENTS.COMMAND], 'command');
  assert.equal(profile.events[SCRIPT_EVENTS.AGENT_GENE], 'agentGene');
});

test('a command turn is told apart typed, namespaced or as the host renders it', () => {
  assert.deepEqual(parse('/evolver-search  redis retries '), { name: 'evolver-search', args: 'redis retries' });
  assert.deepEqual(parse('/evolver:evolver-status'), { name: 'evolver-status', args: '' });
  assert.deepEqual(parse(PAYLOADS.renderedCommand), { name: 'evolver-distill', args: '' });
  assert.equal(parse('用 Node 写一个 LRU 缓存'), null);
  assert.equal(parse('/compact'), null);
});

test('an argument the host left unsubstituted is no argument', () => {
  assert.deepEqual(parse('/evolver-search $ARGUMENTS', SCRIPT_EVENTS.COMMAND), { name: 'evolver-search', args: '' });
  assert.deepEqual(parse('/evolver-distill the eviction order', SCRIPT_EVENTS.COMMAND), { name: 'evolver-distill', args: 'the eviction order' });
});

test('a command script finds its session in the shell the host runs it in', () => {
  assert.equal(profile.commands.sessionOf({ CODEBUDDY_SESSION_ID: 'a', CLAUDE_SESSION_ID: 'b' }), 'a');
  assert.equal(profile.commands.sessionOf({ CLAUDE_SESSION_ID: 'b' }), 'b');
  assert.equal(profile.commands.sessionOf({}), null);
});

test('state lives in the plugin data folder the host hands over, else in ~/.evolver/workbuddy-hooks', () => {
  assert.equal(profile.stateDir({ CODEBUDDY_PLUGIN_DATA: '/data/evolver-evomap-workbuddy', HOME: '/h' }), '/data/evolver-evomap-workbuddy');
  assert.match(profile.stateDir({ HOME: '/h' }), /^[\\/]h[\\/]\.evolver[\\/]workbuddy-hooks$/);
});

test('a command answers its text; a hook answers {} and a command script a sentence when there is nothing to say', () => {
  assert.equal(profile.reply.command({ ok: true, text: 'No distilled drafts are waiting.' }, SCRIPT_EVENTS.COMMAND, {}), 'No distilled drafts are waiting.');
  assert.deepEqual(profile.reply.empty('FinalStop'), {});
  assert.match(profile.reply.empty(SCRIPT_EVENTS.COMMAND), /outside a WorkBuddy session/);
});

test('a Gene the headless model could not write is handed to the agent with a command whose heredoc ends on the nonce', () => {
  const payload = { session_id: "s'1", script: '/plugin/bin/command.mjs', nonce: '0123456789abcdef', state_dir: '/data/evolver' };
  const result = { ok: false, text: 'Distillation model_failed: spawn codebuddy ENOENT.', agentGene: { writtenFor: 1700, prompt: 'Below is the record…' } };
  const lines = profile.reply.command(result, SCRIPT_EVENTS.COMMAND, payload).split('\n');
  assert.equal(lines[0], 'EVOLVER: WRITE THE GENE YOURSELF');
  assert.match(lines[1], /\(Distillation model_failed: spawn codebuddy ENOENT\)\.$/);
  assert.equal(lines[5], "CODEBUDDY_SESSION_ID='s'\\''1' CODEBUDDY_PLUGIN_DATA='/data/evolver' node '/plugin/bin/command.mjs' workbuddy evolver-distill --post 1700 <<'EVOLVER_GENE_0123456789abcdef'");
  assert.deepEqual(lines.slice(6, 8), ['<the JSON object>', 'EVOLVER_GENE_0123456789abcdef']);
  assert.equal(lines.at(-1), 'Below is the record…');
});

test('the headless model is the CodeBuddy CLI with no tools and one turn, on the turn\'s model when it is a plain id', () => {
  assert.equal(profile.model.kind, 'cli');
  assert.equal(profile.model.command({}), 'codebuddy');
  assert.equal(profile.model.shim, true);
  assert.deepEqual(profile.model.args({ model: 'glm-5' }), ['-p', '--tools', '', '--no-session-persistence', '--output-format', 'json', '--max-turns', '1', '--model', 'glm-5']);
  assert.equal(profile.model.args({ model: 'bad model; rm -rf' }).includes('--model'), false);
});

test('the answer and its token cost come from the result object, alone or among events; no answer throws', () => {
  assert.deepEqual(profile.model.parse({ stdout: JSON.stringify(RESULT) }), { answer: '{"summary":"s"}', usage: { inputTokens: 900, outputTokens: 120 } });
  assert.equal(profile.model.parse({ stdout: JSON.stringify([{ type: 'system' }, RESULT]) }).answer, '{"summary":"s"}');
  assert.equal(profile.model.parse({ stdout: JSON.stringify({ ...RESULT, usage: undefined }) }).usage, null);
  assert.throws(() => profile.model.parse({ stdout: 'Authentication required. Please use /login command to sign in to your account\n' }), /Authentication required/);
  assert.throws(() => profile.model.parse({ stdout: JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['quota'] }) }), /quota/);
  assert.throws(() => profile.model.parse({ stdout: '' }), /empty output/);
});
