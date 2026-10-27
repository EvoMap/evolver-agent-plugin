import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import grok from '../../../hosts/grok/profile.js';
import { modelRunnerOf } from '../../../lib/runtime/model-executor.js';

const posix = { skip: process.platform === 'win32' && 'the fake grok is a shell script' };
const fixture = (name) => readFileSync(new URL(`../../fixtures/grok/${name}`, import.meta.url), 'utf8');
const FAKE_GROK = fileURLToPath(new URL('../../fixtures/grok/fake-grok/', import.meta.url));

test('the distillation is one print-mode answer in an empty folder, with no tools, subagents, plan mode or web search', () => {
  assert.deepEqual(grok.model.args({ model: null }, 'PROMPT', { workdir: '/tmp/evolver-model-x', promptPath: '/tmp/evolver-model-x/prompt.md' }), [
    '--prompt-file', '/tmp/evolver-model-x/prompt.md', '--output-format', 'json', '--verbatim', '--cwd', '/tmp/evolver-model-x',
    '--no-auto-update', '--no-subagents', '--no-plan', '--disable-web-search', '--max-turns', '1',
    '--tools', 'todo_write', '--disallowed-tools', 'todo_write,search_tool,use_tool',
  ]);
  assert.deepEqual(grok.model.args({ model: 'grok-4.6' }, 'PROMPT', { workdir: '/w', promptPath: '/w/p' }).slice(-2), ['-m', 'grok-4.6']);
  assert.equal(grok.model.args({ model: 'x; rm -rf /' }, 'PROMPT', { workdir: '/w', promptPath: '/w/p' }).includes('-m'), false);
  assert.equal(grok.model.args({ model: null }, 'PROMPT', { workdir: '/w', promptPath: '/w/p' }).includes('--always-approve'), false, 'a tool call would need an approval nobody gives');
  assert.equal(grok.model.promptFile, 'prompt.md', 'grok documents --prompt-file, not a prompt on stdin');
  assert.equal(grok.model.workdir, 'empty');
  assert.deepEqual(grok.model.command.names, ['grok']);
  assert.deepEqual(grok.model.command.dirs({ HOME: '/h' }), ['/h/.grok/bin'], 'where the installer puts grok');
});

test('the run turns off the Claude Code and Cursor files grok imports, its turn summary and its memory', () => {
  for (const vendor of ['CLAUDE', 'CURSOR']) {
    for (const surface of ['HOOKS', 'MCPS', 'RULES', 'SKILLS', 'AGENTS']) assert.equal(grok.model.env[`GROK_${vendor}_${surface}_ENABLED`], 'false', `${vendor} ${surface}`);
  }
  assert.equal(grok.model.env.GROK_TURN_SUMMARY, 'false');
  assert.equal(grok.model.env.GROK_MEMORY, '0');
});

test('the answer is the json result\'s text and its usage; an error object, a cut run, extra turns or no output throws', () => {
  assert.deepEqual(grok.model.parse({ stdout: fixture('print-answer.json'), stderr: '' }), {
    answer: 'Side answer.',
    usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
  });
  assert.throws(() => grok.model.parse({ stdout: fixture('print-error.json'), stderr: '' }), /grok gave no answer: Internal error: [\s\S]*model not found: fake-model/);
  assert.throws(() => grok.model.parse({ stdout: fixture('print-stop-gate.json'), stderr: '' }), /grok gave no answer: the run took 9 model turns \(a Stop hook of yours keeps a turn going\)/);
  const cut = JSON.stringify({ ...JSON.parse(fixture('print-answer.json')), text: '', stopReason: 'max_turn_requests' });
  assert.throws(() => grok.model.parse({ stdout: cut, stderr: 'Error: max turns reached' }), /grok gave no answer: max_turn_requests/);
  assert.throws(() => grok.model.parse({ stdout: '', stderr: 'not logged in' }), /grok gave no answer: not logged in/);
});

test('the runner finds grok and runs it headless in an empty folder, the prompt in a file there', posix, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'evolver-grok-headless-'));
  try {
    const log = join(scratch, 'calls.jsonl');
    const env = { ...process.env, PATH: [FAKE_GROK, dirname(process.execPath), process.env.PATH].join(delimiter), FAKE_GROK_NODE: process.execPath, FAKE_GROK_LOG: log };
    const reply = await modelRunnerOf(grok.model, env).complete({ model: null }, '## Task\nadd a retry', AbortSignal.timeout(10_000));
    assert.equal(JSON.parse(reply.answer).title, 'Retry uploads');
    const [call] = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(call.prompt, '## Task\nadd a retry');
    assert.equal(call.headless, '1', 'the plugin\'s own hooks stay quiet inside the run');
    assert.equal(call.isolation.GROK_CLAUDE_HOOKS_ENABLED, 'false');
    const workdir = call.args[call.args.indexOf('--cwd') + 1];
    assert.match(basename(workdir), /^evolver-model-/);
    assert.equal(basename(call.cwd), basename(workdir));
    assert.equal(existsSync(workdir), false, 'the empty folder is removed after the run');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('without a grok on the PATH or in ~/.grok/bin there is no headless model', () => {
  assert.equal(modelRunnerOf(grok.model, { PATH: '/nonexistent', HOME: '/nonexistent' }), null);
});
