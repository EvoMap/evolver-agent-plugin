import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODEX_TURN } from './fixtures/codex-turn.mjs';

const RUNNER = fileURLToPath(new URL('../bin/command-hook.mjs', import.meta.url));
const PROMPT = 'fix the flaky redis connection retries in our tests';
const ASSET = {
  asset_id: 'sha256:' + 'a'.repeat(64),
  short_title: 'Fix flaky Redis connection retries',
  summary: 'Stabilise redis connection retries in tests',
  signals_match: ['redis', 'connection', 'retries', 'flaky'],
  strategy: [
    'Set `maxRetriesPerRequest` to null in lib/redis.js',
    'Run npm test to confirm the suite passes',
    'Wrap the client in a singleton factory module',
    'Close the connection in the global teardown hook',
  ],
};

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'evolver-agent-plugin-cmd-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const proxy = { up: true, reports: [], paths: [] };
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    proxy.paths.push(request.url);
    if (!proxy.up) {
      response.writeHead(503).end('{}');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (request.url === '/recipe/search') return response.end('[]');
    if (request.url === '/asset/fetch') return response.end(JSON.stringify({ assets: [ASSET] }));
    if (request.url === '/asset/reuse-result') proxy.reports.push(JSON.parse(body));
    response.end(JSON.stringify({ recorded: true }));
  });
  t.after(() => new Promise((done) => server.close(done)));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  mkdirSync(join(home, '.evolver'), { recursive: true });
  writeFileSync(join(home, '.evolver/settings.json'), JSON.stringify({ proxy: { url: `http://127.0.0.1:${server.address().port}`, token: 't' } }));
  const transcript = join(root, 'rollout.jsonl');
  writeFileSync(transcript, '');
  const run = (host, event, input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, host, event], { env: { PATH: process.env.PATH, HOME: home } });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output: JSON.parse(out || 'null') }));
    child.stdin.end(JSON.stringify(input));
  });
  return { home, proxy, transcript, run };
}

test('Codex: a prompt gets one strategy, and the turn end reports it with the checks the rollout shows', async (t) => {
  const f = await fixture(t);
  await f.run('codex', 'SessionStart', { session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' });
  const submitted = await f.run('codex', 'UserPromptSubmit', { session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: PROMPT, transcript_path: f.transcript });
  assert.equal(submitted.code, 0);
  assert.equal(submitted.output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(submitted.output.hookSpecificOutput.additionalContext, /^\[Evolution Memory\] Fix flaky Redis connection retries \(EvoMap network\):\n1\. Set `maxRetriesPerRequest`/);

  appendFileSync(f.transcript, CODEX_TURN + '\n');
  const stopped = await f.run('codex', 'Stop', { session_id: 's1', hook_event_name: 'Stop', transcript_path: f.transcript, stop_hook_active: false });
  assert.match(stopped.output.systemMessage, /^✓ Goal reached \(last check passed: npm test\) · reused EvoMap strategy "Fix flaky Redis connection retries"/);
  assert.equal(f.proxy.reports.length, 1);
  const [report] = f.proxy.reports;
  assert.equal(report.asset_id, ASSET.asset_id);
  assert.equal(report.task_id, 'codex:s1:1');
  assert.equal(report.outcome, 'success');
  assert.deepEqual(report.evidence, { tier: 'L1', applied: 'used', check: { kind: 'test', passed: true, fail_then_pass: true }, aborted: false, stage: 'immediate' });
  assert.doesNotMatch(JSON.stringify(f.proxy.reports), /flaky redis connection retries in our tests/);

  await f.run('codex', 'UserPromptSubmit', { session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: 'that is wrong, it still fails', transcript_path: f.transcript });
  const correction = f.proxy.reports.find((entry) => entry.task_id === 'codex:s1:1:correction');
  assert.equal(correction.outcome, 'failed');
  assert.equal(correction.evidence.stage, 'correction');
});

test('Codex: an asset injected once is not injected again in the same session', async (t) => {
  const f = await fixture(t);
  const input = { session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: PROMPT, transcript_path: f.transcript };
  assert.ok((await f.run('codex', 'UserPromptSubmit', input)).output.hookSpecificOutput);
  assert.deepEqual((await f.run('codex', 'UserPromptSubmit', input)).output, {});
});

test('a report the Proxy cannot take waits in the session file and is delivered at the next session start', async (t) => {
  const f = await fixture(t);
  await f.run('codex', 'UserPromptSubmit', { session_id: 'old', prompt: PROMPT, transcript_path: f.transcript });
  f.proxy.up = false;
  appendFileSync(f.transcript, CODEX_TURN + '\n');
  await f.run('codex', 'Stop', { session_id: 'old', transcript_path: f.transcript });
  assert.equal(f.proxy.reports.length, 0);
  f.proxy.up = true;
  await f.run('codex', 'SessionStart', { session_id: 'new', source: 'startup' });
  assert.deepEqual(f.proxy.reports.map((report) => report.task_id), ['codex:old:1']);
  assert.deepEqual(readdirSync(join(f.home, '.evolver/agent-plugin/codex')).sort(), ['session-old.json']);
});

test('Muse Code: the prompt is recalled for, and without a readable transcript the report counts as exposure only', async (t) => {
  const f = await fixture(t);
  const submitted = await f.run('muse-code', 'UserPromptSubmit', { session_id: 'm1', prompt: PROMPT, transcript_path: f.transcript });
  assert.match(submitted.output.hookSpecificOutput.additionalContext, /Fix flaky Redis connection retries/);
  appendFileSync(f.transcript, CODEX_TURN + '\n');
  await f.run('muse-code', 'Stop', { session_id: 'm1', transcript_path: f.transcript, last_assistant_message: 'done' });
  assert.equal(f.proxy.reports[0].task_id, 'muse-code:m1:1');
  assert.equal(f.proxy.reports[0].evidence.tier, 'none');
});

test('a subagent stop, an unknown host and malformed input answer an empty object', async (t) => {
  const f = await fixture(t);
  await f.run('codex', 'UserPromptSubmit', { session_id: 's1', prompt: PROMPT, transcript_path: f.transcript });
  assert.deepEqual((await f.run('codex', 'Stop', { session_id: 's1', agent_id: 'sub-1', transcript_path: f.transcript })).output, {});
  assert.equal(f.proxy.reports.length, 0);
  assert.deepEqual((await f.run('nope', 'Stop', {})).output, {});
  const child = await new Promise((resolve) => {
    const run = spawn(process.execPath, [RUNNER, 'codex', 'UserPromptSubmit'], { env: { PATH: process.env.PATH, HOME: f.home } });
    let out = '';
    run.stdout.on('data', (chunk) => { out += chunk; });
    run.on('close', (code) => resolve({ code, out }));
    run.stdin.end('{not json');
  });
  assert.deepEqual(child, { code: 0, out: '{}' });
});
