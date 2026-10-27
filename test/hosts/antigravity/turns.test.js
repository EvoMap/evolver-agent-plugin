import assert from 'node:assert/strict';
import { test } from 'node:test';

import profile from '../../../hosts/antigravity/profile.js';
import { createDriver } from '../../../lib/agent/driver.js';
import { PROMPT, memoryPorts } from '../../app/memory-ports.js';

// Whole Antigravity turns through the driver: hook payloads as the docs give them, the turn itself only in the
// transcript, written step by step the way Antigravity appends it.

const FAILED_RUN = 'The command exited with code 1.\nOutput:\nnot ok 1 - retries\nAssertionError: expected 1 to equal 2\n';
const PASSED_RUN = 'The command exited with code 0.\nOutput:\nℹ tests 2\nℹ pass 2\nℹ fail 0\n';

function conversation(id = 's1') {
  let text = '';
  let step = 0;
  const write = (fields) => {
    step += 1;
    text += `${JSON.stringify({ step_index: step, status: 'DONE', created_at: new Date(Date.UTC(2026, 9, 26, 9, 0, step)).toISOString(), ...fields })}\n`;
  };
  const base = { conversationId: id, workspacePaths: ['/workspace/project'], transcriptPath: `/brain/${id}/transcript_full.jsonl`, modelName: 'gemini-test' };
  const made = memoryPorts();
  made.ports.identity = { agent: profile.name, label: profile.label };
  const driver = createDriver({ profile, ports: made.ports, transcripts: { size: () => text.length, readSince: () => text }, lifetime: 'ephemeral' });
  return {
    ...made,
    prompt: (prompt) => write({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>` }),
    command: (CommandLine, content) => {
      write({ source: 'MODEL', type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { CommandLine } }] });
      write({ source: 'MODEL', type: 'RUN_COMMAND', content });
    },
    edit: async (TargetFile) => {
      const answer = await driver.handle('PreToolUse', { ...base, toolCall: { name: 'write_to_file', args: { TargetFile } }, stepIdx: step });
      write({ source: 'MODEL', type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'write_to_file', args: { TargetFile } }] });
      write({ source: 'MODEL', type: 'CODE_ACTION', content: 'created' });
      return answer;
    },
    answer: (content) => write({ source: 'MODEL', type: 'PLANNER_RESPONSE', content }),
    invoke: () => driver.handle('PreInvocation', { ...base, invocationNum: 0, initialNumSteps: step }),
    stop: (fields = {}) => driver.handle('Stop', { ...base, executionNum: 0, terminationReason: 'NO_TOOL_CALL', error: '', fullyIdle: true, ...fields }),
  };
}

const fetches = (requests) => requests.filter((request) => request.path === '/asset/fetch').length;

async function verifiedTurn(s) {
  s.prompt(PROMPT);
  const injected = await s.invoke();
  await s.edit('/workspace/project/lib/redis.js');
  s.command('npm test', FAILED_RUN);
  s.command('npm test 2>&1 | tail -5', PASSED_RUN);
  s.answer('Retries fixed; npm test passes.');
  return { injected, stopped: await s.stop() };
}

test('the first model call after a new prompt recalls once; each later call of the turn gets the strategy again', async () => {
  const s = conversation();
  s.prompt(PROMPT);
  const first = await s.invoke();
  assert.match(first.injectSteps[0].ephemeralMessage, /Apply them where they fit\.$/);
  assert.doesNotMatch(first.injectSteps[0].ephemeralMessage, /evolver_/);
  s.command('npm test', PASSED_RUN);
  assert.deepEqual(await s.invoke(), first);
  assert.equal(fetches(s.requests), 1);
  assert.deepEqual(s.requests.find((request) => request.path === '/asset/fetch').body.text, PROMPT);
});

test('Stop reports the strategy as used with the transcript\'s evidence, and the verified turn becomes the candidate', async () => {
  const s = conversation();
  const { stopped } = await verifiedTurn(s);
  assert.deepEqual(stopped, { decision: 'stop' });
  const [{ report }] = s.queued;
  assert.equal(report.task_id, 'antigravity:s1:1');
  assert.equal(report.outcome, 'success');
  assert.deepEqual(report.evidence, { tier: 'L1', applied: 'used', check: { kind: 'test', passed: true, fail_then_pass: true }, aborted: false, stage: 'immediate' });
  const candidate = (await s.ports.candidates.read()).s1;
  assert.equal(candidate.prompt, PROMPT);
  assert.deepEqual(candidate.model, { model: 'gemini-test' });
  assert.equal(candidate.answer, 'Retries fixed; npm test passes.');
  assert.deepEqual([...s.retained[0].editedBefore.keys()], ['/workspace/project/lib/redis.js']);
});

test('PreToolUse hands every edit on with allow, after hashing its file', async () => {
  const s = conversation();
  s.prompt(PROMPT);
  await s.invoke();
  assert.deepEqual(await s.edit('/workspace/project/lib/redis.js'), { decision: 'allow' });
});

test('a Stop whose reason is unknown settles nothing; a later Stop closes the turn on its whole record', async () => {
  const s = conversation();
  s.prompt(PROMPT);
  await s.invoke();
  assert.deepEqual(await s.stop({ terminationReason: 'SOMETHING_NEW' }), { decision: 'stop' });
  assert.equal(s.sessions.get('s1').open, true);
  assert.deepEqual(s.queued, []);
  s.command('npm test', PASSED_RUN);
  s.answer('Done.');
  await s.stop({ terminationReason: 'model_stop' });
  assert.equal(s.queued[0].report.evidence.tier, 'L1');
});

test('a cancelled turn is reported aborted; a turn cut short at max steps is no success', async () => {
  const cancelled = conversation();
  cancelled.prompt(PROMPT);
  await cancelled.invoke();
  await cancelled.stop({ terminationReason: 'CANCELED' });
  assert.deepEqual([cancelled.queued[0].report.outcome, cancelled.queued[0].report.evidence.aborted], ['failed', true]);
  const cut = conversation();
  cut.prompt(PROMPT);
  await cut.invoke();
  await cut.stop({ terminationReason: 'max_steps_exceeded' });
  assert.deepEqual([cut.queued[0].report.outcome, cut.queued[0].report.evidence.aborted], ['failed', false]);
});

test('a turn that got no Stop ends as an error once the next prompt opens a turn', async () => {
  const s = conversation();
  s.prompt(PROMPT);
  await s.invoke();
  s.prompt('continue with the README');
  await s.invoke();
  assert.equal(s.queued[0].report.task_id, 'antigravity:s1:1');
  assert.equal(s.queued[0].report.outcome, 'failed');
  assert.equal(s.sessions.get('s1').turn, 2);
});

test('a correction in the next prompt drops the candidate and reports the reuse again under :correction', async () => {
  const s = conversation();
  await verifiedTurn(s);
  s.prompt('还是报错，不对');
  await s.invoke();
  assert.deepEqual(await s.ports.candidates.read(), {});
  assert.ok(s.queued.some(({ report }) => report.task_id === 'antigravity:s1:1:correction' && report.outcome === 'failed'));
});

test('with no SessionStart, the first model call under a new Antigravity process starts the session, once', async () => {
  const s = conversation();
  s.ports.engine.takeUnannounced = async () => ({ status: 'started', version: '2.0.46', at: 1 });
  s.prompt(PROMPT);
  const first = await s.invoke();
  assert.match(first.injectSteps[0].ephemeralMessage, /^\[Evolver\] The Evolver Proxy was not running[\s\S]*Apply them where they fit\.$/);
  s.ports.engine.takeUnannounced = async () => null;
  await s.invoke();
  assert.equal(s.scheduled.filter((task) => task === 'distill').length, 1);
  s.ports.owner.current = () => 5151;
  await s.invoke();
  assert.equal(s.scheduled.filter((task) => task === 'distill').length, 2, 'a resumed conversation under a new process starts again');
});

test('a turn that runs again after its Stop opens no second turn, and its later Stop re-judges the candidate', async () => {
  const s = conversation();
  await verifiedTurn(s);
  s.command('npm test', FAILED_RUN);
  assert.deepEqual(await s.invoke(), {});
  assert.equal(s.sessions.get('s1').turn, 1);
  s.answer('The background run failed.');
  await s.stop();
  assert.deepEqual(await s.ports.candidates.read(), {});
  assert.equal(fetches(s.requests), 1);
});

test('a model call before the next prompt reaches the transcript opens no turn', async () => {
  const s = conversation();
  await verifiedTurn(s);
  assert.deepEqual(await s.invoke(), {});
  assert.equal(s.sessions.get('s1').turn, 1);
  assert.equal(fetches(s.requests), 1);
});

test('a turn closed by the next prompt is judged on its transcript, not as a bare error', async () => {
  const s = conversation();
  s.prompt(PROMPT);
  await s.invoke();
  s.command('npm test', PASSED_RUN);
  s.prompt('now the README');
  await s.invoke();
  assert.deepEqual([s.queued[0].report.outcome, s.queued[0].report.evidence.tier], ['success', 'L1']);
});

test('where no Antigravity process is found, the session still starts only once', async () => {
  const s = conversation();
  s.ports.owner.current = () => null;
  s.prompt(PROMPT);
  await s.invoke();
  await s.invoke();
  assert.equal(s.scheduled.filter((task) => task === 'distill').length, 1);
});
