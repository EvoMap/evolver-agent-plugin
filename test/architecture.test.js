import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function filesUnder(dir) {
  if (!existsSync(join(root, dir))) return [];
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(root, path)).isDirectory() ? filesUnder(path) : path.endsWith('.js') ? [path] : [];
  });
}

const importsOf = (file) => [...readFileSync(join(root, file), 'utf8').matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1]);
const targetOf = (file, specifier) => (specifier.startsWith('.') ? relative(root, join(root, file, '..', specifier)) : specifier);

const LAYERS = [
  ['agents/', 'agents'],
  ['lib/channels/', 'channels'],
  ['lib/agent/', 'agent'],
  ['lib/runtime/', 'runtime'],
  ['lib/app/', 'app'],
  ['lib/claude-code/', 'claude-code'],
  ['lib/local-ledger.js', 'runtime'],
  ['lib/', 'domain'],
];
const layerOf = (path) => LAYERS.find(([prefix]) => path.startsWith(prefix))?.[1] ?? 'external';

const MAY_IMPORT = {
  domain: ['domain'],
  app: ['domain', 'app'],
  runtime: ['domain', 'runtime'],
  agent: ['domain', 'app', 'runtime', 'agent'],
  channels: ['domain', 'app', 'runtime', 'agent', 'channels'],
  agents: ['domain', 'agent', 'agents'],
};

const NODE_FREE = new Set(['domain', 'app']);
const SHARED_LAYERS = new Set(['domain', 'app', 'runtime', 'agent', 'channels']);

test('each layer imports only the layers below it, and domain and app never touch Node', () => {
  const problems = [];
  for (const file of [...filesUnder('lib'), ...filesUnder('agents')]) {
    const layer = layerOf(file);
    if (!MAY_IMPORT[layer]) continue;
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith('node:')) {
        if (NODE_FREE.has(layer)) problems.push(`${file} (${layer}) imports ${specifier}`);
        continue;
      }
      const target = layerOf(targetOf(file, specifier));
      if (target === 'external') {
        if (layer !== 'channels') problems.push(`${file} (${layer}) imports package ${specifier}`);
        continue;
      }
      if (!MAY_IMPORT[layer].includes(target)) problems.push(`${file} (${layer}) imports ${specifier} (${target})`);
    }
  }
  assert.deepEqual(problems, []);
});

test('no shared layer names an agent or branches on the platform outside the runtime', () => {
  const agentsDir = join(root, 'agents');
  const agentNames = existsSync(agentsDir) ? readdirSync(agentsDir).filter((name) => statSync(join(agentsDir, name)).isDirectory()) : [];
  const problems = [];
  for (const file of filesUnder('lib').filter((path) => SHARED_LAYERS.has(layerOf(path)))) {
    const source = readFileSync(join(root, file), 'utf8');
    for (const name of agentNames) if (new RegExp(`['"\`]${name}['"\`]`).test(source)) problems.push(`${file} names agent ${name}`);
    if (layerOf(file) !== 'runtime' && /process\.platform|win32/.test(source)) problems.push(`${file} branches on the platform`);
  }
  assert.deepEqual(problems, []);
});
