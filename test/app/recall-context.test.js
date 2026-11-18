import assert from 'node:assert/strict';
import { test } from 'node:test';

import { promptSubmitted } from '../../lib/app/prompt.js';
import { memoryPorts } from './memory-ports.js';

const fetchContexts = (requests) => requests.filter(({ path }) => path === '/asset/fetch').map(({ body }) => body.context);

test('a recall carries the typed prompts before it as recent turns, oldest first, and the first prompt carries none', async () => {
  const { ports, requests } = memoryPorts();
  const prompts = ['How do I grow a Xiaohongshu account?', 'Which note formats work best?', 'And how often should I post?'];
  for (const prompt of prompts) await promptSubmitted(ports, { sessionId: 's', prompt, waitMs: 5_000 });
  const [first, second, third] = fetchContexts(requests);
  assert.equal(first.recent_turns, undefined);
  assert.deepEqual(second.recent_turns, [{ role: 'user', text: prompts[0] }]);
  assert.deepEqual(third.recent_turns, [{ role: 'user', text: prompts[0] }, { role: 'user', text: prompts[1] }]);
  assert.equal(third.task, prompts[0], 'the task stays the session\'s first prompt');
});

test('a typed command is not a recent turn', async () => {
  const { ports, requests } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's', prompt: 'Add retries to the uploader client', waitMs: 5_000 });
  await promptSubmitted(ports, { sessionId: 's', prompt: '/evolver-status', isCommand: true, waitMs: 5_000 });
  await promptSubmitted(ports, { sessionId: 's', prompt: 'Now cap the retries at five', waitMs: 5_000 });
  assert.deepEqual(fetchContexts(requests).at(-1).recent_turns, [{ role: 'user', text: 'Add retries to the uploader client' }]);
});
