import assert from 'node:assert/strict';
import { test } from 'node:test';

import { taskIdsOf, turnStatusOf } from '../../../hosts/kimi/transcript.js';

const meta = { type: 'metadata', protocol_version: '1.5' };
const profile = { type: 'profile.bind', agentId: 'main', modelAlias: 'custom/model-b', thinkingEffort: 'off' };
const prompt = (id, promptId = `prompt-${id}`) => ({ type: 'turn.prompt', agentId: 'main', turnId: id, promptId, origin: { kind: 'user' }, input: [{ type: 'text', text: 'same prompt' }] });
const event = value => ({ type: 'context.append_loop_event', agentId: 'main', event: value });
const ended = (turnId, reason = 'completed') => ({ type: 'turn.ended', agentId: 'main', turnId, reason });
const status = (records, tasks = [], turnId = '0') => turnStatusOf(records, { turnId, tasks });

test('Kimi native turn zero is a real identity and runs until its terminal', () => {
  const row = status([meta, profile, { ...prompt(0), $offset: 128 }]);
  assert.equal(row.status, 'accepted');
  assert.deepEqual(row.record.checks, []);
  assert.equal(row.model, null, 'a profile binding alone is no route the turn ran on');
});

test('a matched native terminal cannot prove a silent Bash check passed and only the final model text is its answer', () => {
  const records = [meta, profile, prompt(0),
    { type: 'llm.request', agentId: 'main', modelAlias: 'custom/model-b', model: 'upstream-b', provider: 'openai', turnStep: '0.1' },
    event({ type: 'tool.call', uuid: 'call-uuid', turnId: '0', toolCallId: 'call-test', name: 'Bash', args: { command: 'npm test' } }),
    event({ type: 'tool.result', parentUuid: 'call-uuid', toolCallId: 'call-test', result: { output: '', durationMs: 1 } }),
    event({ type: 'content.part', uuid: 'part-answer', turnId: '0', stepUuid: 'final-step', part: { type: 'text', text: 'Fixed the retry; tests pass.' } }),
    event({ type: 'step.end', uuid: 'final-step', turnId: '0', finishReason: 'end_turn', providerFinishReason: 'completed' }),
    { type: 'agent.message.appended', message: { message: { role: 'assistant', content: [{ type: 'text', text: 'unrelated hook notice' }] } } },
    { type: 'turn.ended', agentId: 'main', turnId: 0, reason: 'completed' },
  ];
  const row = status(records);
  assert.deepEqual(row.record.checks, [{ command: 'npm test', exit: null, failed: null }]);
  assert.equal(row.status, 'completed');
  assert.equal(row.answer, 'Fixed the retry; tests pass.');
  assert.equal(row.record.answer, row.answer);
  assert.deepEqual(row.model, { alias: 'custom/model-b', effort: null, model: 'upstream-b', protocol: 'openai' });
});

test('a bound turn reads a terminal after the next prompt with only its own evidence', () => {
  const first = [meta, profile, prompt(0),
    { type: 'llm.request', agentId: 'main', modelAlias: 'first', model: 'first-model', provider: 'openai' },
    event({ type: 'tool.call', uuid: 'old-check', turnId: 0, toolCallId: 'check', name: 'Bash', args: { command: 'npm test' } }),
    event({ type: 'tool.result', parentUuid: 'old-check', toolCallId: 'check', result: { output: '# pass 1\n# fail 0', durationMs: 1 } }),
    event({ type: 'content.part', uuid: 'old-answer', turnId: 0, stepUuid: 'old-final', part: { type: 'text', text: 'First answer' } }),
    event({ type: 'step.end', uuid: 'old-final', turnId: 0, finishReason: 'end_turn', providerFinishReason: 'completed' }),
  ];
  const second = [prompt(1),
    { type: 'llm.request', agentId: 'main', modelAlias: 'second', model: 'second-model', provider: 'openai' },
    event({ type: 'content.part', uuid: 'new-answer', turnId: 1, stepUuid: 'new-final', part: { type: 'text', text: 'Second answer' } }),
    event({ type: 'step.end', uuid: 'new-final', turnId: 1, finishReason: 'end_turn', providerFinishReason: 'completed' }),
  ];
  const records = [...first, ...second, ended(0)];
  const row = status(records);
  assert.equal(row.status, 'completed');
  assert.deepEqual(row.record.checks, [{ command: 'npm test', exit: null, failed: false }]);
  assert.equal(row.answer, 'First answer');
  assert.deepEqual(row.model, { alias: 'first', effort: null, model: 'first-model', protocol: 'openai' });
  assert.equal(status(records, [], '1').status, 'accepted', 'the next turn has not ended');
  assert.equal(status([...first, ended(0, 'failed'), ...second, ended(0)]), null, 'contradictory terminals are no status');
});

test('a background Bash is settled by its task metadata, never by successful TaskOutput retrieval', () => {
  const records = [meta, profile, prompt(0),
    event({ type: 'tool.call', uuid: 'bg-uuid', turnId: '0', toolCallId: 'bg-call', name: 'Bash', args: { command: 'npm test', run_in_background: true } }),
    event({ type: 'tool.result', parentUuid: 'bg-uuid', toolCallId: 'bg-call', result: { output: 'task_id: bash-task\nstatus: running', durationMs: 1 } }),
    event({ type: 'tool.call', uuid: 'output-uuid', turnId: '0', toolCallId: 'output-call', name: 'TaskOutput', args: { task_id: 'bash-task' } }),
    event({ type: 'tool.result', parentUuid: 'output-uuid', toolCallId: 'output-call', result: { output: 'retrieval_status: success\nstatus: failed', durationMs: 1 } }),
  ];
  const task = { taskId: 'bash-task', kind: 'process', parentToolCallId: 'bg-call', command: 'npm test', status: 'failed', exitCode: 7 };
  const done = [...records, ended(0)];
  assert.deepEqual(status(done, [task]).record.checks, [{ command: 'npm test', exit: 7, failed: true }]);
  assert.deepEqual(status(done, [{ ...task, parentToolCallId: 'another-turn' }]).record.checks, [{ command: 'npm test', exit: null, failed: null }]);
  for (const [taskStatus, exitCode, exit, failed] of [['failed', 0, 0, true], ['failed', undefined, null, true], ['completed', 0, 0, false], ['completed', undefined, null, null], ['running', 0, null, null]]) {
    const row = status(done, [{ ...task, status: taskStatus, exitCode }]);
    assert.deepEqual(row.record.checks, [{ command: 'npm test', exit, failed }]);
    assert.equal(row.status, taskStatus === 'running' ? 'pending' : 'completed', 'a running background check keeps an ended turn pending');
  }
});

test('a turn id names its own prompt, and an unknown or ambiguous one has no status', () => {
  const records = [meta, profile, prompt(0), prompt(1)];
  assert.equal(status(records, [], '1').status, 'accepted');
  assert.equal(status(records, [], '2'), null);
  assert.equal(status([...records, prompt(1, 'other-prompt')], [], '1'), null);
  assert.equal(status(records, [], 'not-a-turn'), null);
});

test('unsupported schemas and foreign agents do not supply evidence', () => {
  assert.equal(status([{ ...meta, protocol_version: '9.0' }, prompt(0)]), null);
  assert.equal(status([prompt(0)]), null);
  assert.equal(status([meta, { ...prompt(0), agentId: 'helper' }]), null);
  assert.equal(status([meta, { ...prompt(0), origin: { kind: 'cron' } }]), null);
});

test('fixed task discovery rejects paths and does not inspect arbitrary output paths', () => {
  const records = [event({ type: 'tool.call', name: 'TaskOutput', args: { task_id: 'bash-task' } }), event({ type: 'tool.result', result: { output: 'task_id: bash-task\nstatus: running' } }), event({ type: 'tool.call', name: 'TaskOutput', args: { task_id: '../outside' } })];
  assert.deepEqual(taskIdsOf(records), ['bash-task']);
});

test('duplicate native events do not duplicate checks and mismatched results remain unknown', () => {
  const call = event({ type: 'tool.call', uuid: 'id', turnId: '0', toolCallId: 'test', name: 'Bash', args: { command: 'npm test' } });
  const result = event({ type: 'tool.result', parentUuid: 'id', toolCallId: 'test', result: { output: '# pass 1\n# fail 0', durationMs: 1 } });
  assert.deepEqual(status([meta, prompt(0), call, call, result, result]).record.checks, [{ command: 'npm test', exit: null, failed: false }]);
  assert.deepEqual(status([meta, prompt(0), call, { ...result, event: { ...result.event, parentUuid: 'another-turn' } }]).record.checks, [{ command: 'npm test', exit: null, failed: null }]);
});

test('foreground native errors and summaries retain verdicts without inventing process exit codes', () => {
  const call = event({ type: 'tool.call', uuid: 'id', turnId: '0', toolCallId: 'test', name: 'Bash', args: { command: 'npm test' } });
  for (const [output, isError, failed] of [['# pass 1\n# fail 0', false, false], ['', false, null], ['ordinary output', undefined, null], ['timed out', true, true]]) {
    const result = event({ type: 'tool.result', parentUuid: 'id', toolCallId: 'test', result: { output, durationMs: 1, isError } });
    assert.deepEqual(status([meta, prompt(0), call, result]).record.checks,
      [{ command: 'npm test', exit: null, failed }]);
  }
});

test('conflicting call identities and completed terminals containing an error cannot verify a turn', () => {
  const call = event({ type: 'tool.call', uuid: 'id', turnId: '0', toolCallId: 'test', name: 'Bash', args: { command: 'npm test' } });
  const result = event({ type: 'tool.result', parentUuid: 'id', toolCallId: 'test', result: { output: '', durationMs: 1 } });
  const conflicting = { ...call, event: { ...call.event, args: { command: 'npm run build' } } };
  assert.equal(status([meta, prompt(0), call, conflicting, result, ended(0)]), null);
  assert.equal(status([meta, prompt(0), call, result, { ...ended(0), error: { code: 'provider.api_error' } }]), null);
  assert.equal(status([meta, prompt(0), call, result, ended(0, 'failed')]).status, 'failed');
  assert.equal(status([meta, prompt(0), ended(0, 'interrupted')]).status, 'aborted');
});

test('a later turn and a truncated continuation cannot become an earlier turn final answer', () => {
  const records = [meta, profile, prompt(0),
    event({ type: 'content.part', uuid: 'earlier', turnId: '0', stepUuid: 'first-step', part: { type: 'text', text: 'Earlier answer' } }),
    event({ type: 'step.end', uuid: 'first-step', turnId: '0', finishReason: 'end_turn', providerFinishReason: 'completed' }),
    event({ type: 'step.end', uuid: 'last-step', turnId: '0', finishReason: 'max_tokens', providerFinishReason: 'truncated' }),
    { ...profile, modelAlias: 'later-route' }, prompt(1),
  ];
  assert.equal(status(records).record.answer, '');
});
