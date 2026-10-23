export const line = (payload, type = 'response_item') => JSON.stringify({ timestamp: '2026-10-22T10:00:00Z', type, payload });

export const CODEX_TURN = [
  line({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the flaky redis connection retries in our tests' }] }),
  line({ type: 'user_message', message: 'fix the flaky redis connection retries in our tests' }, 'event_msg'),
  line({ type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'], workdir: '/proj' }) }),
  line({ type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: '1 failing', metadata: { exit_code: 1 } }) }),
  line({ type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: lib/redis.js\n-export const retries = 3;\n+export const retries = null;\n*** End Patch' }),
  line({ type: 'custom_tool_call_output', call_id: 'c2', output: 'Success. Updated the following files:\nM lib/redis.js' }),
  line({ type: 'function_call', name: 'exec_command', call_id: 'c3', arguments: JSON.stringify({ cmd: 'npm test' }) }),
  line({ type: 'function_call_output', call_id: 'c3', output: 'Exit code: 0\nWall time: 2.1 seconds\nOutput:\nall 12 tests passed' }),
  line({ type: 'function_call', name: 'shell', call_id: 'c4', arguments: JSON.stringify({ command: ['git', 'status'] }) }),
  line({ type: 'function_call_output', call_id: 'c4', output: 'Exit code: 0' }),
  line({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Set `maxRetriesPerRequest` to null; npm test passes.' }] }),
  line({ type: 'agent_message', message: 'Set maxRetriesPerRequest to null.' }, 'event_msg'),
].join('\n');

const exec = (callId, script) => line({ type: 'custom_tool_call', name: 'exec', call_id: callId, status: 'completed', input: script });
const execOutput = (callId, ...results) => line({
  type: 'custom_tool_call_output',
  call_id: callId,
  output: [
    { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
    ...results.map(({ exitCode, output }) => ({ type: 'input_text', text: JSON.stringify({ chunk_id: 'c', wall_time_seconds: 0.1, exit_code: exitCode, output }) })),
  ],
});

export const CODEX_CODE_MODE_TURN = [
  line({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the flaky redis connection retries in our tests' }] }),
  exec('e1', 'text(await tools.exec_command({cmd:"npm test",max_output_tokens:9000}));\ntext(await tools.exec_command({cmd:"git status"}));'),
  execOutput('e1', { exitCode: 1, output: '1 failing' }, { exitCode: 0, output: 'clean' }),
  exec('e2', 'text(await tools.apply_patch({input:"*** Begin Patch\\n*** Update File: lib/redis.js\\n-export const retries = 3;\\n+export const retries = null;\\n*** End Patch"}));'),
  execOutput('e2'),
  exec('e3', "text(await tools.exec_command({cmd:'npm test'}));"),
  execOutput('e3', { exitCode: 0, output: 'all 12 tests passed' }),
  line({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Set `maxRetriesPerRequest` to null; npm test passes.' }] }),
].join('\n');
