// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { homedir } from 'node:os';
import { join } from 'node:path';
import { modelArguments } from './model.js';
import { dataDirOf } from './paths.js';

export { dataDirOf } from './paths.js';

/** Let MiniMax's YAML parser merge the original routing and credentials; no YAML dependency or secret logging. */
export function headlessConfigOf(source) {
  const lines = source.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').split('\n');
  const prefix = [];
  while (lines.length && /^(?:\s*(?:#.*)?|%.*)$/.test(lines[0])) prefix.push(lines.shift());
  if (/^---(?:\s*(?:#.*)?)?$/.test(lines[0] ?? '')) lines.shift();
  let last = lines.length - 1;
  while (last >= 0 && /^\s*(?:#.*)?$/.test(lines[last])) last -= 1;
  if (/^\.\.\.(?:\s*(?:#.*)?)?$/.test(lines[last] ?? '')) lines.splice(last, 1);
  if (lines.some(line => /^(?:---|\.\.\.)(?:\s|$)/.test(line))) throw new Error('MiniMax configuration must contain one YAML document');
  const agents = { default: { tools: [], builtinTools: [], skills: [], features: { mavis: false, delegation: false, webSearch: false } } };
  return [
    ...prefix, ...(prefix.some(line => line.startsWith('%')) ? ['---'] : []),
    '<<:', ...lines.map(line => `  ${line}`),
    `agents: ${JSON.stringify(agents)}`,
    'memory: {enabled: false}', 'askUser: {enabled: false}', 'goal: {enabled: false}',
    '',
  ].join('\n');
}

export function completionOf({ stdout }) {
  let result;
  try { result = JSON.parse(stdout); } catch { throw new Error('MiniMax returned no valid completion'); }
  if (result?.schemaVersion !== 1 || result.type !== 'exec.result' || result.status !== 'succeeded' || typeof result.output !== 'string' || !result.output.trim()) {
    const code = /^[A-Z0-9_]+$/.test(result?.error?.code ?? '') ? ` (${result.error.code})` : '';
    throw new Error(`MiniMax returned no successful completion${code}`);
  }
  const usage = result.usage;
  return { answer: result.output, usage: Number.isFinite(usage?.inputTokens) && Number.isFinite(usage?.outputTokens) ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : null };
}

export const headlessMiniMax = Object.freeze({
  kind: 'cli',
  command: { names: ['mcode'], windowsShims: true, dirs: env => {
    const home = env.HOME || env.USERPROFILE || homedir();
    return [join(home, '.minimax-code'), join(home, '.local', 'bin')];
  } },
  workdir: 'empty',
  env: env => { const root = dataDirOf(env); return { MINIMAX_DATA_DIR: root, MAVIS_DATA_DIR: root }; },
  configFile: { source: env => join(dataDirOf(env), 'config.yaml'), prepare: headlessConfigOf },
  args: (model, prompt, { configPath }) => ['exec', '--input', '-', '--config', configPath, ...modelArguments(model), '--mode', 'lightweight', '--permission', 'smart', '--max-steps', '1', '--timeout', '90s', '--output-format', 'json'],
  parse: completionOf,
});
