import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDriver } from '../../lib/agent/driver.js';
import { defineProfile } from '../../lib/agent/profile.js';
import mcpGeneric from '../../hosts/mcp-generic/profile.js';
import { PROMPT, memoryPorts } from '../app/memory-ports.js';

const HOOK_EVENTS = { SessionStart: 'sessionStart', UserPromptSubmit: 'prompt', PreToolUse: 'beforeEdit', PostToolUse: 'toolResult', Stop: 'turnEnd', SessionEnd: 'sessionEnd' };
const evidence = {
  toolNote: (payload) => (payload.tool_name === 'Bash' ? { kind: 'shell', command: payload.tool_input.command, exit: payload.tool_response.exit_code } : null),
  editedFile: (payload) => payload.tool_input?.file_path ?? null,
};
const hookProfile = (extra = {}) => defineProfile({ name: 'testhook', label: 'Test Hook', events: HOOK_EVENTS, evidence, budgets: { prompt: 8_000 }, ...extra });
const noTranscripts = { size: () => 0, readSince: () => '' };
const driverOf = (profile, made = memoryPorts(), transcripts = noTranscripts) => ({ ...made, driver: createDriver({ profile, ports: made.ports, transcripts, lifetime: 'ephemeral' }) });
const base = { session_id: 's1', cwd: '/proj' };

test('a profile missing a difference point fails when it is defined, naming what is wrong', () => {
  assert.throws(() => defineProfile({ name: 'Bad Name', label: 'x', events: { A: 'nope' } }),
    /name must be lower-case.*events must map host events to canonical events.*evidence\.toolNote and evidence\.editedFile or editedFiles are required/);
});

test('a prompt answers the recalled strategy in the hook channel\'s shape', async () => {
  const { driver } = driverOf(hookProfile());
  const answer = await driver.handle('UserPromptSubmit', { ...base, prompt: PROMPT });
  assert.equal(answer.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(answer.hookSpecificOutput.additionalContext.endsWith('Apply them where they fit.'));
});

test('a whole turn through the driver reports its injection with the check the tool hook saw', async () => {
  const { driver, queued } = driverOf(hookProfile());
  await driver.handle('UserPromptSubmit', { ...base, prompt: PROMPT });
  await driver.handle('PostToolUse', { ...base, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { exit_code: 1 } });
  assert.deepEqual(await driver.handle('Stop', { ...base, last_assistant_message: 'Done.' }), {});
  assert.equal(queued[0].report.outcome, 'failed');
  assert.equal(queued[0].report.evidence.check.passed, false);
});

test('an intercepted command answers in the chat and starts no turn', async () => {
  const made = memoryPorts();
  const { driver } = driverOf(hookProfile({ commands: { entry: 'intercept' } }), made);
  const answer = await driver.handle('UserPromptSubmit', { ...base, prompt: '/evolver-sync --dry-run' });
  assert.equal(answer.hookSpecificOutput.additionalContext, 'ran sync --dry-run in /proj');
  assert.equal(made.sessions.get('s1'), undefined);
});

test('an unknown end reason leaves the turn open; a subagent, an unmapped event or a failure answers empty', async () => {
  const made = memoryPorts();
  const { driver } = driverOf(hookProfile({ turnEnd: { reason: () => 'unknown' } }), made);
  await driver.handle('UserPromptSubmit', { ...base, prompt: PROMPT });
  await driver.handle('Stop', base);
  assert.equal(made.sessions.get('s1').open, true);
  assert.deepEqual(await driver.handle('UserPromptSubmit', { ...base, agent_id: 'sub', prompt: PROMPT }), {});
  assert.deepEqual(await driver.handle('Notification', base), {});
  made.ports.sessions.update = async () => { throw new Error('disk full'); };
  assert.deepEqual(await driver.handle('UserPromptSubmit', { ...base, prompt: PROMPT }), {});
});

test('a host whose injection lasts one call gets the open turn\'s strategy again, without a second recall', async () => {
  const made = memoryPorts();
  const { driver, requests } = driverOf(hookProfile({ reply: { lifetime: 'call' }, payload: { turnId: (payload) => payload.turn } }), made);
  const first = await driver.handle('UserPromptSubmit', { ...base, turn: 't1', prompt: PROMPT });
  const again = await driver.handle('UserPromptSubmit', { ...base, turn: 't1', prompt: PROMPT });
  assert.deepEqual(again, first);
  assert.equal(requests.filter((request) => request.path === '/asset/fetch').length, 1);
});

test('a host without a session-start event starts a session when its owner changes, and says the engine notice once', async () => {
  const made = memoryPorts();
  made.ports.engine.takeUnannounced = async () => ({ status: 'started', version: '2.0.46', at: 1 });
  const { driver } = driverOf(hookProfile({ sessionStart: 'owner-change' }), made);
  const answer = await driver.handle('UserPromptSubmit', { ...base, prompt: PROMPT });
  assert.match(answer.hookSpecificOutput.additionalContext, /^\[Evolver\] The Evolver Proxy was not running/);
  assert.ok(made.scheduled.includes('distill'));
});

test('a host that keeps a transcript hands the turn record over from it', async () => {
  const transcript = '{"cmd":"npm test","exit":0}\n';
  const transcripts = { size: () => 7, readSince: (file, offset) => (offset === 7 ? transcript : '') };
  const profile = hookProfile({
    evidence: {
      ...evidence,
      turnStart: (payload, context) => context.transcriptSize(),
      turnRecord: (payload, context) => {
        const lines = context.transcriptSince(context.turnStart).trim().split('\n').map((line) => JSON.parse(line));
        return { checks: lines.map((line) => ({ command: line.cmd, failed: line.exit !== 0 })), commands: lines.map((line) => line.cmd), paths: ['a.js'], edits: ['a.js'], answer: '' };
      },
    },
  });
  const { driver, ports } = driverOf(profile, memoryPorts(), transcripts);
  await driver.handle('UserPromptSubmit', { ...base, prompt: PROMPT, transcript_path: '/t.jsonl' });
  await driver.handle('Stop', { ...base, transcript_path: '/t.jsonl', last_assistant_message: 'Fixed.' });
  assert.deepEqual((await ports.candidates.read()).s1.checks, [{ command: 'npm test', failed: false }]);
});

test('the MCP profile turns tool calls into a turn whose report is agent-reported and asks for a Gene', async () => {
  const made = memoryPorts({ distillAnswer: null });
  const { driver, queued } = driverOf(mcpGeneric, made);
  const recalled = await driver.handle('evolver_recall', { session_id: 'm1', task: PROMPT });
  assert.ok(recalled.content[0].text.endsWith('Apply them where they fit.'));
  const reported = await driver.handle('evolver_report', { session_id: 'm1', outcome: 'success', summary: 'Fixed the retries.', checks: [{ command: 'npm test', exit: 0 }], files: ['lib/redis.js'] });
  assert.match(reported.content[0].text, /call evolver_distill with written_for \d+/);
  assert.equal(queued[0].report.evidence.reported_by, 'agent');
  assert.equal(queued[0].report.evidence.tier, 'none');
  const status = await driver.handle('evolver_status', { session_id: 'm1' });
  assert.match(status.content[0].text, /verified turn waiting to be distilled/);
});

test('a session start answers the engine notice once, and a session end schedules distillation', async () => {
  const made = memoryPorts();
  made.ports.engine.takeUnannounced = async () => ({ status: 'install_failed', error: 'npm missing', at: 1 });
  const { driver } = driverOf(hookProfile(), made);
  const answer = await driver.handle('SessionStart', base);
  assert.match(answer.hookSpecificOutput.additionalContext, /^\[Evolver\] Installing Evolver failed \(npm missing\)/);
  assert.deepEqual(await driver.handle('SessionEnd', base), {});
  assert.ok(made.scheduled.includes('distill'));
});

test('over MCP, only the report of the turn that became the candidate asks for a Gene', async () => {
  const made = memoryPorts();
  const { driver } = driverOf(mcpGeneric, made);
  await driver.handle('evolver_recall', { session_id: 'm1', task: PROMPT });
  const first = await driver.handle('evolver_report', { session_id: 'm1', outcome: 'success', summary: 'Fixed.', checks: [{ command: 'npm test', exit: 0 }], files: ['a.js'] });
  assert.match(first.content[0].text, /evolver_distill/);
  await driver.handle('evolver_recall', { session_id: 'm1', task: 'now explain what changed in the retry logic' });
  const second = await driver.handle('evolver_report', { session_id: 'm1', outcome: 'failed', summary: 'Gave up.' });
  assert.equal(second.content[0].text, 'Reported.');
});
