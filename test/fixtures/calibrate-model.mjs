import { readFileSync } from 'node:fs';

// A model command for scripts/distill-calibrate.mjs: reads the prompt on stdin and answers as `claude -p --output-format json` does.
const ir = JSON.parse(readFileSync(new URL('./session-ir.json', import.meta.url), 'utf8'));
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ type: 'result', result: JSON.stringify([ir]), prompt_chars: prompt.length })));
