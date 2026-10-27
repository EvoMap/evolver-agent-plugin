// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every manifest whose `version` a release names: each host's plugin or package, and the marketplace entries for them. */
export const VERSIONED_FILES = Object.freeze([
  'package.json',
  '.claude-plugin/marketplace.json',
  '.codebuddy-plugin/marketplace.json',
  '.cursor-plugin/marketplace.json',
  '.cursor-plugin/plugin.json',
  '.grok-plugin/marketplace.json',
  '.qoder-plugin/marketplace.json',
  'hosts/antigravity/dist/plugin.json',
  'hosts/claude-code/dist/.claude-plugin/plugin.json',
  'hosts/codex/dist/.codex-plugin/plugin.json',
  'hosts/dsh/dist/package.json',
  'hosts/grok/dist/.grok-plugin/plugin.json',
  'hosts/opencode/dist/package.json',
  'hosts/qoder/dist/.qoder-plugin/plugin.json',
  'hosts/workbuddy/dist/.codebuddy-plugin/marketplace.json',
  'hosts/workbuddy/dist/.codebuddy-plugin/plugin.json',
]);

/** The marketplaces that install a packed folder from the release's tag, and the docs that name that tag. */
export const TAG_FILES = Object.freeze([
  '.claude-plugin/marketplace.json',
  '.codebuddy-plugin/marketplace.json',
  '.grok-plugin/marketplace.json',
  '.qoder-plugin/marketplace.json',
  'README.md',
  'docs/architecture.md',
  'hosts/codex/dist/README.md',
  'hosts/dsh/dist/README.md',
  'hosts/opencode/dist/README.md',
]);

const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
const VERSION_FIELD = new RegExp(String.raw`("version"\s*:\s*")(${SEMVER})(")`, 'g');
const TAG_MENTION = /("ref"\s*:\s*"|--ref |--branch )([^\s"`]+)/g;

export const tagOf = (version) => `v${version}`;

const read = (file) => readFileSync(join(ROOT, file), 'utf8');

/** Every version a manifest names, as `{ file, version }`. */
export const versionsNamed = () => VERSIONED_FILES.flatMap((file) => [...read(file).matchAll(VERSION_FIELD)].map((found) => ({ file, version: found[2] })));

/** Every release tag a marketplace or doc names, as `{ file, tag }`. */
export const tagsNamed = () => TAG_FILES.flatMap((file) => [...read(file).matchAll(TAG_MENTION)].map((found) => ({ file, tag: found[2] })));

/** What disagrees with releasing `version`: a manifest naming another version, or a marketplace or doc another tag. */
export function mismatchesFor(version) {
  const versions = versionsNamed().filter((named) => named.version !== version).map((named) => `${named.file}: version ${named.version}`);
  const tags = tagsNamed().filter((named) => named.tag !== tagOf(version)).map((named) => `${named.file}: tag ${named.tag}`);
  return [...versions, ...tags];
}

function setVersion(version) {
  for (const file of VERSIONED_FILES) writeFileSync(join(ROOT, file), read(file).replace(VERSION_FIELD, `$1${version}$3`));
  for (const file of TAG_FILES) writeFileSync(join(ROOT, file), read(file).replace(TAG_MENTION, `$1${tagOf(version)}`));
  const lock = JSON.parse(read('package-lock.json'));
  lock.version = version;
  lock.packages[''].version = version;
  writeFileSync(join(ROOT, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
}

function main([command, value]) {
  const version = String(value ?? '').replace(/^v/, '');
  if (!new RegExp(`^${SEMVER}$`).test(version) || !['set', 'check'].includes(command)) {
    console.error('Usage: node scripts/release-version.mjs set <x.y.z> | check <vX.Y.Z>');
    return 2;
  }
  if (command === 'set') {
    setVersion(version);
    console.log(`Every manifest now names ${version}, and every marketplace and doc ${tagOf(version)}.`);
    return 0;
  }
  const mismatches = mismatchesFor(version);
  if (mismatches.length === 0) return 0;
  console.error(`Not ready to release ${tagOf(version)}; run node scripts/release-version.mjs set ${version}:\n${mismatches.join('\n')}`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
