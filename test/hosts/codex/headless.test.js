import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import codex from '../../../hosts/codex/profile.js';
import { modelRunnerOf } from '../../../lib/runtime/model-executor.js';
import { ownerProbeOf } from '../../../lib/runtime/process/owner.js';

const posix = { skip: process.platform === 'win32' && 'the fake codex is a shell script' };
const fixture = (name) => readFileSync(new URL(`../../fixtures/codex/${name}`, import.meta.url), 'utf8');
const FAKE_CODEX = fileURLToPath(new URL('../../fixtures/codex/fake-codex/', import.meta.url));
const ownerIn = (rows) => {
  const table = new Map(rows);
  return ownerProbeOf(codex.owner, { probe: (pid) => table.get(pid) ?? null, platform: 'darwin' }).current();
};

test('the distillation is one read-only codex exec on the session model, with hooks, plugins and the user config off', () => {
  assert.deepEqual(codex.model.args({ model: 'gpt-5.5' }, 'PROMPT', { workdir: '/tmp/evolver-model-x' }), [
    'exec', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '--ignore-user-config', '--json',
    '--sandbox', 'read-only',
    '--disable', 'hooks', '--disable', 'plugins', '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'multi_agent',
    '-c', 'web_search="disabled"',
    '-m', 'gpt-5.5',
    '-C', '/tmp/evolver-model-x',
    '-',
  ]);
  assert.equal(codex.model.args({ model: 'gpt 5; rm -rf /' }, 'PROMPT', { workdir: '/w' }).includes('-m'), false, 'a model name no flag can carry runs on the default');
  assert.equal(codex.model.input, undefined, 'the prompt goes on stdin, which `-` names');
  assert.equal(codex.model.workdir, 'empty');
  assert.deepEqual(codex.model.command.names, ['codex']);
});

test('the answer is the last agent message of the --json events and the usage that of the turn', () => {
  assert.deepEqual(codex.model.parse({ stdout: fixture('exec-headless.jsonl'), stderr: '' }), {
    answer: '{"title":"Null retries for flaky Redis","summary":"Stop ioredis retrying per request in tests.","strategy":["Set maxRetriesPerRequest to null.","Run the suite."],"validation":["node --test passes"],"signals":["redis","retries"]}',
    usage: { inputTokens: 1200, cachedInputTokens: 200, outputTokens: 50, reasoningOutputTokens: 0 },
  });
  assert.deepEqual(codex.model.parse({ stdout: fixture('exec-turn-0.144.jsonl'), stderr: '' }), {
    answer: 'Tests pass: 1 passed, 0 failed.',
    usage: { inputTokens: 26729, cachedInputTokens: 23680, outputTokens: 136, reasoningOutputTokens: 0 },
  });
});

test('a run that answered no agent message fails with what Codex said', () => {
  const reconnecting = fixture('exec-headless.jsonl').split('\n').filter((line) => !line.includes('agent_message')).join('\n');
  assert.throws(() => codex.model.parse({ stdout: reconnecting, stderr: '' }), /codex exec gave no answer: Reconnecting\.\.\. 5\/5/);
  const failed = `${JSON.stringify({ type: 'turn.failed', error: { message: 'model not found' } })}\n`;
  assert.throws(() => codex.model.parse({ stdout: failed, stderr: '' }), /codex exec gave no answer: model not found/);
  assert.throws(() => codex.model.parse({ stdout: '', stderr: 'Not logged in' }), /Not logged in/);
});

test('the runner finds codex on PATH and runs it headless in an empty folder, the prompt on stdin', posix, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'evolver-codex-headless-'));
  try {
    const log = join(scratch, 'calls.jsonl');
    const env = { ...process.env, PATH: [FAKE_CODEX, dirname(process.execPath), process.env.PATH].join(delimiter), FAKE_CODEX_NODE: process.execPath, FAKE_CODEX_LOG: log };
    const runner = modelRunnerOf(codex.model, env);
    const reply = await runner.complete({ model: 'gpt-5.5' }, '## Task\nadd a retry', AbortSignal.timeout(10_000));
    assert.equal(JSON.parse(reply.answer).title, 'Retry uploads');
    assert.deepEqual(reply.usage, { inputTokens: 900, cachedInputTokens: 0, outputTokens: 120, reasoningOutputTokens: 0 });
    const [call] = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(call.prompt, '## Task\nadd a retry');
    assert.equal(call.headless, '1');
    const workdir = call.args.at(-2);
    assert.match(basename(workdir), /^evolver-model-/);
    assert.equal(basename(call.cwd), basename(workdir), 'codex runs in the folder it is told to work in');
    assert.equal(existsSync(workdir), false, 'the empty folder is removed after the run');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('without a codex to run there is no headless model', () => {
  assert.equal(modelRunnerOf(codex.model, { PATH: '/nonexistent' }), null);
});

test('the owner is the nearest ancestor named codex*, past the login shell Codex runs the hook in', () => {
  assert.equal(ownerIn([
    [process.ppid, { ppid: 700, name: 'zsh' }],
    [700, { ppid: 600, name: 'codex', path: '/opt/homebrew/Caskroom/codex/0.164.0/bin/codex' }],
    [600, { ppid: 1, name: 'zsh' }],
  ]), 700);
  assert.equal(ownerIn([
    [process.ppid, { ppid: 650, name: 'zsh' }],
    [650, { ppid: 600, name: 'codex-aarch64-apple-darwin' }],
    [600, { ppid: 1, name: 'Codex', path: '/Applications/Codex.app/Contents/MacOS/Codex' }],
  ]), 650, 'the app-server, not the app that started it');
  assert.equal(ownerIn([[process.ppid, { ppid: 1, name: 'zsh' }]]), null);
});
