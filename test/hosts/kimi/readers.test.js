import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeNativeFacts, taskIdsOf } from '../../../hosts/kimi/transcript.js';

const meta = { type: 'metadata', protocol_version: '1.5' };
const profile = { type: 'profile.bind', agentId: 'main', modelAlias: 'custom/model-b', thinkingEffort: 'off' };
const prompt = (id, promptId = `prompt-${id}`) => ({ type: 'turn.prompt', agentId: 'main', turnId: id, promptId, origin: { kind: 'user' }, input: [{ type: 'text', text: 'same prompt' }] });
const event = value => ({ type: 'context.append_loop_event', agentId: 'main', event: value });

test('Kimi native turn zero and the active binding are distinct from a global default model', () => {
  const p = { ...prompt(0), $offset: 128 };
  const facts = decodeNativeFacts([meta, profile, p], [], { hook_event_name: 'TurnStarted', turn_id: 0 });
  assert.equal(facts.schemaSupported, true);
  assert.deepEqual(facts.bind, { turnId: '0', promptId: 'prompt-0', origin: 'user', mark: 128 });
  assert.deepEqual(facts.modelHint, { alias: 'custom/model-b', effort: 'off' });
  assert.equal(facts.terminal, null);
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
  const facts = decodeNativeFacts(records, [], { hook_event_name: 'Stop' }, { turnId: '0' });
  assert.deepEqual(facts.record.checks, [{ command: 'npm test', exit: null, failed: null }]);
  assert.equal(facts.pendingVerification, false);
  assert.equal(facts.record.answer, 'Fixed the retry; tests pass.');
  assert.deepEqual(facts.terminal, { turnId: '0', reason: 'completed', answer: 'Fixed the retry; tests pass.', modelHint: { alias: 'custom/model-b', effort: null, model: 'upstream-b', protocol: 'openai' } });
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
  const ended = { type: 'turn.ended', agentId: 'main', turnId: 0, reason: 'completed' };
  const records = [...first, ...second, ended];
  const facts = decodeNativeFacts(records, [], {}, { turnId: '0' });
  assert.equal(facts.bind.promptId, 'prompt-0');
  assert.deepEqual(facts.record.checks, [{ command: 'npm test', exit: null, failed: false }]);
  assert.deepEqual(facts.terminal, { turnId: '0', reason: 'completed', answer: 'First answer',
    modelHint: { alias: 'first', effort: null, model: 'first-model', protocol: 'openai' } });
  assert.equal(decodeNativeFacts(records, [], { turn_id: 0 }).terminal, null, 'a hook payload alone cannot extend the read');
  assert.equal(decodeNativeFacts([...first, { ...ended, reason: 'failed' }, ...second, ended], [], {}, { turnId: '0' }).status, 'partial');
});

test('a background Bash is settled by its task metadata, never by successful TaskOutput retrieval', () => {
  const records = [meta, profile, prompt(0),
    event({ type: 'tool.call', uuid: 'bg-uuid', turnId: '0', toolCallId: 'bg-call', name: 'Bash', args: { command: 'npm test', run_in_background: true } }),
    event({ type: 'tool.result', parentUuid: 'bg-uuid', toolCallId: 'bg-call', result: { output: 'task_id: bash-task\nstatus: running', durationMs: 1 } }),
    event({ type: 'tool.call', uuid: 'output-uuid', turnId: '0', toolCallId: 'output-call', name: 'TaskOutput', args: { task_id: 'bash-task' } }),
    event({ type: 'tool.result', parentUuid: 'output-uuid', toolCallId: 'output-call', result: { output: 'retrieval_status: success\nstatus: failed', durationMs: 1 } }),
  ];
  const task = { taskId: 'bash-task', kind: 'process', parentToolCallId: 'bg-call', command: 'npm test', status: 'failed', exitCode: 7 };
  assert.deepEqual(decodeNativeFacts(records, [task], {}, { turnId: '0' }).record.checks, [{ command: 'npm test', exit: 7, failed: true }]);
  assert.deepEqual(decodeNativeFacts(records, [{ ...task, parentToolCallId: 'another-turn' }], {}, { turnId: '0' }).record.checks, [{ command: 'npm test', exit: null, failed: null }]);
  for (const [status, exitCode, exit, failed] of [['failed', 0, 0, true], ['failed', undefined, null, true], ['completed', 0, 0, false], ['completed', undefined, null, null], ['running', 0, null, null]]) {
    const facts = decodeNativeFacts(records, [{ ...task, status, exitCode }], {}, { turnId: '0' });
    assert.deepEqual(facts.record.checks, [{ command: 'npm test', exit, failed }]);
    assert.equal(facts.pendingVerification, status === 'running');
  }
});

test('late observer events cannot guess the latest of two identical prompts', () => {
  const records = [meta, profile, { ...prompt(0), $offset: 100 }, { ...prompt(1), $offset: 200 }];
  assert.equal(decodeNativeFacts(records, [], { hook_event_name: 'Stop' }).bind, null);
  assert.equal(decodeNativeFacts(records, [], { hook_event_name: 'Stop' }, { after: { offset: 100 } }).bind, null);
  assert.equal(decodeNativeFacts(records, [], {}, { after: { offset: 200 } }).bind.turnId, '1');
  assert.equal(decodeNativeFacts(records, [], {}, { turnId: '0' }).bind.turnId, '0');
  assert.equal(decodeNativeFacts(records, [], { hook_event_name: 'UserPromptSubmit' }).bind, null);
});

test('unsupported schemas and foreign agents do not supply evidence', () => {
  assert.equal(decodeNativeFacts([{ ...meta, protocol_version: '9.0' }, prompt(0)], [], { turn_id: 0 }).status, 'unsupported');
  assert.equal(decodeNativeFacts([meta, { ...prompt(0), agentId: 'helper' }], [], { turn_id: 0 }).bind, null);
  const facts = decodeNativeFacts([prompt(0)], [], { turn_id: 0 }, { schemaVersion: '1.5', modelHint: { alias: 'cached', effort: 'off' } });
  assert.deepEqual(facts.modelHint, { alias: 'cached', effort: 'off' });
  assert.equal(facts.bind.turnId, '0');
});

test('fixed task discovery rejects paths and does not inspect arbitrary output paths', () => {
  const records = [event({ type: 'tool.call', name: 'TaskOutput', args: { task_id: 'bash-task' } }), event({ type: 'tool.result', result: { output: 'task_id: bash-task\nstatus: running' } }), event({ type: 'tool.call', name: 'TaskOutput', args: { task_id: '../outside' } })];
  assert.deepEqual(taskIdsOf(records, { task_id: 'other-task' }), ['other-task', 'bash-task']);
});

test('duplicate native events do not duplicate checks and mismatched results remain unknown', () => {
  const call = event({ type: 'tool.call', uuid: 'id', turnId: '0', toolCallId: 'test', name: 'Bash', args: { command: 'npm test' } });
  const result = event({ type: 'tool.result', parentUuid: 'id', toolCallId: 'test', result: { output: '# pass 1\n# fail 0', durationMs: 1 } });
  assert.deepEqual(decodeNativeFacts([meta, prompt(0), call, call, result, result], [], {}, { turnId: '0' }).record.checks, [{ command: 'npm test', exit: null, failed: false }]);
  assert.deepEqual(decodeNativeFacts([meta, prompt(0), call, { ...result, event: { ...result.event, parentUuid: 'another-turn' } }], [], {}, { turnId: '0' }).record.checks, [{ command: 'npm test', exit: null, failed: null }]);
});

test('foreground native errors and summaries retain verdicts without inventing process exit codes', () => {
  const call = event({ type: 'tool.call', uuid: 'id', turnId: '0', toolCallId: 'test', name: 'Bash', args: { command: 'npm test' } });
  for (const [output, isError, failed] of [['# pass 1\n# fail 0', false, false], ['', false, null], ['ordinary output', undefined, null], ['timed out', true, true]]) {
    const result = event({ type: 'tool.result', parentUuid: 'id', toolCallId: 'test', result: { output, durationMs: 1, isError } });
    assert.deepEqual(decodeNativeFacts([meta, prompt(0), call, result], [], {}, { turnId: '0' }).record.checks,
      [{ command: 'npm test', exit: null, failed }]);
  }
});

test('conflicting call identities and completed terminals containing an error cannot verify a turn', () => {
  const call = event({ type: 'tool.call', uuid: 'id', turnId: '0', toolCallId: 'test', name: 'Bash', args: { command: 'npm test' } });
  const result = event({ type: 'tool.result', parentUuid: 'id', toolCallId: 'test', result: { output: '', durationMs: 1 } });
  const facts = decodeNativeFacts([meta, prompt(0), call, { ...call, event: { ...call.event, args: { command: 'npm run build' } } }, result, { type: 'turn.ended', agentId: 'main', turnId: 0, reason: 'completed', error: { code: 'provider.api_error' } }], [], {}, { turnId: '0' });
  assert.equal(facts.status, 'partial');
  assert.equal(facts.terminal, null);
  assert.equal(facts.record, null);
});

test('a later profile binding and a truncated continuation cannot become an earlier turn final answer', () => {
  const records = [meta, profile, prompt(0),
    event({ type: 'content.part', uuid: 'earlier', turnId: '0', stepUuid: 'first-step', part: { type: 'text', text: 'Earlier answer' } }),
    event({ type: 'step.end', uuid: 'first-step', turnId: '0', finishReason: 'end_turn', providerFinishReason: 'completed' }),
    event({ type: 'step.end', uuid: 'last-step', turnId: '0', finishReason: 'max_tokens', providerFinishReason: 'truncated' }),
    { ...profile, modelAlias: 'later-route' }, prompt(1),
  ];
  const facts = decodeNativeFacts(records, [], {}, { turnId: '0' });
  assert.deepEqual(facts.modelHint, { alias: 'custom/model-b', effort: 'off' });
  assert.equal(facts.record.answer, '');
});
