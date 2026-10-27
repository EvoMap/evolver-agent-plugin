import { appendFileSync } from 'node:fs';

const GENE = { title: 'Retry uploads', summary: 'Retry a flaky upload with backoff.', strategy: '1. Measure. 2. Back off.', signals: ['retry'] };

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ args: process.argv.slice(2), prompt, cwd: process.cwd(), headless: process.env.EVOLVER_HEADLESS ?? null })}\n`);
  const events = [
    { type: 'thread.started', thread_id: '01a17b41-234d-7660-97de-2514627287b0' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: process.env.FAKE_CODEX_ANSWER ?? JSON.stringify(GENE) } },
    { type: 'turn.completed', usage: { input_tokens: 900, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 120, reasoning_output_tokens: 0 } },
  ];
  process.stdout.write(events.map((event) => `${JSON.stringify(event)}\n`).join(''));
});
