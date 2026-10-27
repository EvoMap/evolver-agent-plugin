import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { hasComputedImport, importsOf as importsIn } from '../scripts/imports.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

const SOURCE = /\.m?js$/;

function filesUnder(dir) {
  if (!existsSync(join(root, dir))) return [];
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    const stat = lstatSync(join(root, path));
    if (stat.isDirectory()) return filesUnder(path);
    return stat.isFile() && SOURCE.test(path) ? [path] : [];
  });
}

const sourceOf = (file) => readFileSync(join(root, file), 'utf8');
const importsOf = (file) => importsIn(sourceOf(file)).map(({ specifier }) => specifier);
const hostOf = (path) => /^hosts\/([^/]+)\//.exec(path)?.[1] ?? null;
const targetOf = (file, specifier) => (specifier.startsWith('.') ? relative(root, join(root, file, '..', specifier)) : specifier);

// A host's `dist/` and `bin/` are entries: the glue a host loads, which reaches the plugin only through a channel.
const ENTRY = /^(?:bin\/|hosts\/[^/]+\/dist\/)/;

const LAYERS = [
  ['hosts/', 'hosts'],
  ['lib/channels/', 'channels'],
  ['lib/agent/', 'agent'],
  ['lib/runtime/', 'runtime'],
  ['lib/app/', 'app'],
  ['lib/local-ledger.js', 'runtime'],
  ['lib/', 'domain'],
];
const layerOf = (path) => LAYERS.find(([prefix]) => path === prefix)?.[1]
  ?? (ENTRY.test(path) ? 'entries' : LAYERS.find(([prefix]) => path.startsWith(prefix))?.[1] ?? 'external');

const MAY_IMPORT = {
  domain: ['domain'],
  app: ['domain', 'app'],
  runtime: ['domain', 'runtime'],
  agent: ['domain', 'app', 'runtime', 'agent'],
  channels: ['domain', 'app', 'runtime', 'agent', 'channels'],
  hosts: ['domain', 'agent', 'hosts'],
  entries: ['domain', 'channels', 'hosts', 'entries'],
};

// A host's readers are pure functions over payloads; only path and URL helpers (and the home folder for a default
// state directory) are theirs to use.
const PURE_NODE = new Set(['node:path', 'node:url', 'node:os']);

const NODE_FREE = new Set(['domain', 'app']);
// Packages are IO: only the runtime (evolver-core) and the channels (the MCP SDK) take them.
const MAY_IMPORT_PACKAGES = new Set(['runtime', 'channels']);
// An import whose target only the running code knows escapes this check: the runtime's optional packages, and the
// registry, which finds a host's profile by its folder name.
const MAY_COMPUTE_IMPORTS = new Set(['runtime', 'channels']);
const COMPUTED_IMPORT_FILES = new Set(['lib/agent/registry.js']);
const SHARED_LAYERS = new Set(['domain', 'app', 'runtime', 'agent', 'channels']);

test('each layer imports only the layers below it, and domain and app never touch Node', () => {
  const problems = [];
  for (const file of [...filesUnder('lib'), ...filesUnder('hosts'), ...filesUnder('bin')]) {
    const layer = layerOf(file);
    if (!MAY_IMPORT[layer]) continue;
    if (hasComputedImport(sourceOf(file)) && !MAY_COMPUTE_IMPORTS.has(layer) && !COMPUTED_IMPORT_FILES.has(file)) problems.push(`${file} (${layer}) imports a computed module`);
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith('node:')) {
        if (NODE_FREE.has(layer) || (layer === 'hosts' && !PURE_NODE.has(specifier))) problems.push(`${file} (${layer}) imports ${specifier}`);
        continue;
      }
      const target = layerOf(targetOf(file, specifier));
      if (target === 'external') {
        if (!MAY_IMPORT_PACKAGES.has(layer)) problems.push(`${file} (${layer}) imports package ${specifier}`);
        continue;
      }
      if (!MAY_IMPORT[layer].includes(target)) problems.push(`${file} (${layer}) imports ${specifier} (${target})`);
      const targetHost = hostOf(targetOf(file, specifier));
      if (targetHost && targetHost !== hostOf(file)) problems.push(`${file} imports another host's ${specifier}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('no shared layer names an agent or branches on the platform outside the runtime', () => {
  const hostsDir = join(root, 'hosts');
  const agentNames = existsSync(hostsDir) ? readdirSync(hostsDir).filter((name) => lstatSync(join(hostsDir, name)).isDirectory()) : [];
  const problems = [];
  for (const file of filesUnder('lib').filter((path) => SHARED_LAYERS.has(layerOf(path)))) {
    const source = readFileSync(join(root, file), 'utf8');
    for (const name of agentNames) if (new RegExp(`['"\`]${name}['"\`]`).test(source)) problems.push(`${file} names agent ${name}`);
    if (layerOf(file) !== 'runtime' && /process\.platform|win32/.test(source)) problems.push(`${file} branches on the platform`);
  }
  assert.deepEqual(problems, []);
});
