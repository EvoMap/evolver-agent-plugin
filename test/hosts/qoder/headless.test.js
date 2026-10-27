// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import qoder from '../../../hosts/qoder/profile.js';
import { modelRunnerOf } from '../../../lib/runtime/model-executor.js';

// What Qoder CLI 1.1.79 prints for `-p --output-format json`: answered (print-answer.json) and signed out.

const posix = { skip: process.platform === 'win32' && 'the fake qodercli is a shell script' };
const fixture = (name) => readFileSync(new URL(`../../fixtures/qoder/${name}`, import.meta.url), 'utf8');
const FAKE_QODERCLI = fileURLToPath(new URL('../../fixtures/qoder/fake-qodercli/', import.meta.url));

test('the distillation is one print-mode answer with no tools, MCP servers or hooks, nothing saved, on the default model', () => {
  assert.deepEqual(qoder.model.args({ model: 'Auto' }, 'PROMPT', { workdir: '/tmp/evolver-model-x' }), [
    '-p', '--output-format', 'json',
    '--tools', '',
    '--strict-mcp-config',
    '--settings', '{"disableAllHooks":true}',
    '--max-turns', '1',
    '--no-session-persistence',
  ]);
  assert.equal(qoder.model.input, undefined, 'the prompt goes on stdin');
  assert.equal(qoder.model.workdir, 'empty');
  assert.deepEqual(qoder.model.command.names, ['qodercli']);
  assert.deepEqual(qoder.model.command.dirs({ HOME: '/h' }), ['/h/.local/bin', '/h/.qoder/bin/qodercli']);
  assert.equal(qoder.model.command.windowsShims, true);
});

test('the answer is the result of the one JSON object, with its token usage', () => {
  const printed = JSON.parse(fixture('print-answer.json'));
  assert.deepEqual(qoder.model.parse({ stdout: fixture('print-answer.json'), stderr: '' }), { answer: printed.result, usage: { inputTokens: 0, outputTokens: 0 } });
  assert.match(printed.result, /^\{"reusable": true/);
});

test('a signed-out CLI fails with what it said, and so does output that is no result', () => {
  assert.throws(() => qoder.model.parse({ stdout: fixture('print-not-logged-in.json'), stderr: '' }), /^Error: qodercli gave no answer: Not logged in · Please run \/login$/);
  assert.throws(() => qoder.model.parse({ stdout: '', stderr: 'boom' }), /qodercli gave no answer: boom/);
  assert.throws(() => qoder.model.parse({ stdout: '{"type":"result"}', stderr: '' }), /qodercli gave no answer/);
});

test('the runner finds qodercli on the PATH and gives it the prompt on stdin in an empty folder, marked headless', posix, async () => {
  const home = mkdtempSync(join(tmpdir(), 'evolver-qoder-headless-'));
  const log = join(home, 'qodercli.log');
  try {
    const env = { HOME: home, PATH: [FAKE_QODERCLI, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), FAKE_QODER_NODE: process.execPath, FAKE_QODER_LOG: log };
    const runner = modelRunnerOf(qoder.model, env);
    const { answer, usage } = await runner.complete(null, 'Distill this turn.');
    assert.equal(JSON.parse(answer).title, 'Retry uploads');
    assert.deepEqual(usage, { inputTokens: 900, outputTokens: 120 });
    const [run] = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(run.args, qoder.model.args(null, 'Distill this turn.', {}));
    assert.equal(run.prompt, 'Distill this turn.');
    assert.equal(run.headless, '1');
    assert.match(run.cwd, /evolver-model-/);
    assert.equal(existsSync(run.cwd), false, 'the empty folder is removed after');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a signed-out qodercli exits 1, and the run fails with its sign-in hint rather than raw output', posix, async () => {
  const home = mkdtempSync(join(tmpdir(), 'evolver-qoder-headless-'));
  try {
    const env = {
      HOME: home, PATH: [FAKE_QODERCLI, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
      FAKE_QODER_NODE: process.execPath, FAKE_QODER_LOG: join(home, 'qodercli.log'), FAKE_QODER_SIGNED_OUT: '1',
    };
    await assert.rejects(modelRunnerOf(qoder.model, env).complete(null, 'Distill this turn.'), /^Error: qodercli gave no answer: Not logged in · Please run \/login$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
