import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const config = args[args.indexOf('--config') + 1];
if (!config || !existsSync(join(process.cwd(), '.evolver-headless')) || !readFileSync(config, 'utf8').includes('"tools":[]')) process.exit(3);
appendFileSync(process.env.FAKE_MINIMAX_LOG, JSON.stringify({ args, cwd: process.cwd(), marker: process.env.EVOLVER_HEADLESS, privateConfig: config }) + '\n');
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (!prompt.includes('session-gene-ir-v1')) process.exit(4);
const ir = readFileSync(new URL('../session-ir.json', import.meta.url), 'utf8');
console.log(JSON.stringify({ schemaVersion: 1, type: 'exec.result', status: 'succeeded', output: ir, usage: { inputTokens: 40, outputTokens: 20 } }));
