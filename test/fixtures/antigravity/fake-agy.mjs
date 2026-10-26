#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Answers like `agy --input-format stream-json --output-format stream-json`: one `user` event per stdin line, a
// `result` event per turn, and an ERROR result with exit 1 for a line that is not JSON, as the headless docs say.
const GENE = { title: 'Retry uploads', summary: 'Retry a flaky upload with backoff.', strategy: '1. Measure. 2. Back off.', signals: ['retry'] };
const usage = { input_tokens: 900, output_tokens: 120, thinking_tokens: 30, cache_read_tokens: 0, total_tokens: 1020 };
const result = (fields) => `${JSON.stringify({ event: 'result', result: { conversation_id: 'c-headless', num_turns: 1, usage, ...fields } })}\n`;

const [line] = readFileSync(0, 'utf8').split('\n');
let prompt;
try {
  prompt = JSON.parse(line).message.content;
} catch {
  process.stdout.write(result({ status: 'ERROR', response: '', error: 'invalid JSON line' }));
  process.exit(1);
}
appendFileSync(join(homedir(), 'fake-agy.log'), `${JSON.stringify({ args: process.argv.slice(2), prompt, cwd: process.cwd(), marker: process.env.EVOLVER_HEADLESS ?? null })}\n`);
process.stdout.write(`${JSON.stringify({ event: 'init', conversation_id: 'c-headless', init: { cwd: process.cwd(), tools: ['run_command'] } })}\n`);
process.stdout.write(result({ status: 'SUCCESS', response: `${JSON.stringify(GENE)}\n` }));
