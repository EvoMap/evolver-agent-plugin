import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

import profile from '../../../hosts/gemini/profile.js';
import { runHookProcess } from '../../../lib/channels/hook/runner.js';
import { PROMPT, RECIPE, RECIPE_STEPS } from '../../app/memory-ports.js';
import { fakeProxy } from '../../helpers/fake-proxy.js';

const marker = 'Gemini recall only fixture';
const nextPrompt = 'Hi';
const sessionId = 'gemini-recall-session';
const requestOf = (...messages) => ({ messages: messages.map(([role, content]) => ({ role, content })) });

function setup(t, proxy) {
  t.after(() => proxy.closeAsync());
  const { HOME } = proxy.env;
  const env = { ...proxy.env, GEMINI_CLI_HOME: HOME, EVOLVER_RECALL: 'on' };
  const dir = profile.stateDir(env);
  const filename = 'gemini-session-' + createHash('sha256').update(sessionId).digest('hex').slice(0, 16) + '.json';
  const timestamp = Date.now();
  const invoke = (event, offset, payload = {}, overrides = {}) => new Promise((resolve, reject) => {
    const stdin = Readable.from([JSON.stringify({
      hook_event_name: event, session_id: sessionId, cwd: HOME, timestamp: new Date(timestamp + offset).toISOString(), ...payload,
    })]);
    let output = '';
    const stdout = { write: (part, done) => { output += part; done(); } };
    runHookProcess('gemini', event, {
      stdin, stdout, env: { ...env, ...overrides }, exit: () => resolve(JSON.parse(output)),
    }).catch(reject);
  });
  return { invoke, dir, filename, stateText: () => readFileSync(join(dir, filename), 'utf8') };
}

const fixture = (options = {}) => fakeProxy({
  assets: [], recipes: [{ ...RECIPE, title: marker }], stepAssets: RECIPE_STEPS, ...options,
});

test('Gemini injects only into the open prompt and closes duplicate SessionEnd once', async (t) => {
  const proxy = await fixture();
  const { invoke, dir, filename, stateText } = setup(t, proxy);
  const nativePrompt = '<session_context>\nThis is the Gemini CLI. We are setting up the context for our chat.\nNative workspace info.\n</session_context>' + PROMPT;
  const first = requestOf(['user', nativePrompt]);
  const continued = requestOf(['user', nativePrompt], ['model', 'I will run a tool.']);
  const next = requestOf(['user', nativePrompt], ['model', 'Done.'], ['user', nextPrompt]);

  assert.deepEqual(await invoke('BeforeAgent', 1, { prompt: PROMPT }), {});
  assert.deepEqual(await invoke('SessionStart', 1), {});
  assert.equal(proxy.requests.length, 0);
  assert.equal(JSON.parse(stateText()).recipe, undefined);
  const initial = await invoke('BeforeModel', 2, { llm_request: { ...first, config: { temperature: 0.4 } } });
  assert.equal(initial.hookSpecificOutput.hookEventName, 'BeforeModel');
  assert.deepEqual(Object.keys(initial.hookSpecificOutput.llm_request), ['messages']);
  const injected = initial.hookSpecificOutput.llm_request.messages[0].content;
  assert.ok(injected.startsWith(nativePrompt));
  assert.ok(injected.includes(marker));
  assert.ok(injected.endsWith('</hook_context>'));
  const identicalLater = requestOf(['user', nativePrompt], ['model', 'Done.'], ['user', PROMPT]);
  assert.deepEqual(await invoke('BeforeModel', 3, { llm_request: identicalLater }), {});
  const secondCall = await invoke('BeforeModel', 3, { llm_request: continued });
  assert.deepEqual(secondCall.hookSpecificOutput.llm_request.messages[1], continued.messages[1]);
  assert.equal(secondCall.hookSpecificOutput.llm_request.messages[0].content, initial.hookSpecificOutput.llm_request.messages[0].content);

  assert.deepEqual(await invoke('BeforeModel', 4, { llm_request: next }), {});
  await invoke('BeforeAgent', 5, { prompt: nextPrompt });
  assert.deepEqual(await invoke('BeforeModel', 6, { llm_request: next }), {});
  await invoke('SessionEnd', 7);
  const closed = stateText();
  assert.equal(JSON.parse(closed).closed, true);
  assert.equal(JSON.parse(closed).recipe, undefined);
  await invoke('SessionEnd', 8);
  assert.equal(stateText(), closed);

  await invoke('SessionStart', 9);
  await invoke('BeforeAgent', 10, { prompt: PROMPT });
  await invoke('SessionEnd', 8);
  const afterResume = await invoke('BeforeModel', 11, { llm_request: first });
  assert.ok(afterResume.hookSpecificOutput.llm_request.messages[0].content.includes(marker));

  await invoke('AfterTool', 12, { tool_name: 'run_shell_command', exitCode: 0 });
  await invoke('AfterAgent', 13);
  await invoke('SessionEnd', 14);
  assert.deepEqual(readdirSync(dir), [filename]);
  assert.ok(proxy.requests.length > 0);
  assert.ok(proxy.requests.every(({ path }) => ['/asset/fetch', '/recipe/search'].includes(path)));
});

test('late recall cannot revive an ended turn, and disabling recall clears a previous prompt', async (t) => {
  const proxy = await fixture({ delays: { '/recipe/search': 1_000 } });
  const { invoke, stateText } = setup(t, proxy);
  await invoke('SessionStart', 0);
  await invoke('BeforeAgent', 1, { prompt: PROMPT });
  const pending = invoke('BeforeModel', 2, { llm_request: requestOf(['user', PROMPT]) });
  while (proxy.requests.length === 0) {
    const waiting = await Promise.race([pending.then(() => false), sleep(20, true)]);
    assert.ok(waiting, 'the recall must still be pending when the first request reaches the Proxy');
  }
  await invoke('SessionEnd', 3);
  assert.deepEqual(await pending, {});
  assert.equal(JSON.parse(stateText()).recipe, undefined);
  assert.deepEqual(await invoke('BeforeModel', 3, { llm_request: requestOf(['user', PROMPT]) }), {});

  await invoke('SessionStart', 4);
  await invoke('BeforeAgent', 5, { prompt: PROMPT });
  const recalled = await invoke('BeforeModel', 6, { llm_request: requestOf(['user', PROMPT]) });
  assert.ok(recalled.hookSpecificOutput.llm_request.messages[0].content.includes(marker));
  assert.ok(JSON.parse(stateText()).recipe?.includes(marker));
  await invoke('BeforeAgent', 7, { prompt: PROMPT }, { EVOLVER_RECALL: 'off' });
  assert.equal(JSON.parse(stateText()).recipe, undefined);
  assert.deepEqual(await invoke('BeforeModel', 8, { llm_request: requestOf(['user', PROMPT]) }), {});

  const requestCount = proxy.requests.length;
  const reference = PROMPT + '\n--- Content from referenced files ---\nPRIVATE-FIXTURE-TEXT';
  await invoke('BeforeAgent', 9, { prompt: reference });
  assert.deepEqual(await invoke('BeforeModel', 10, { llm_request: requestOf(['user', reference]) }), {});
  assert.equal(proxy.requests.length, requestCount);
});
