// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// A Gene pins a skill it needs as one `preconditions` entry (Evolver 2.0.54 and later):
//   skill:git+https://github.com/owner/repo@<commit>#sha256=<digest>&path=<dir>
// The plugin gives the model no tools, so it names the skill with the Evolver command that installs it. Evolver
// fetches the pinned commit and checks the digest; this only reads which skills there are and where they land.
const GIT_PREFIX = 'skill:git+';
const MAX_SKILLS = 8;
const ASSET_ID = /^sha256:[0-9a-f]{64}$/;
const PIN = /^https:\/\/[^\s#@]+@[0-9a-f]{40}(?:[0-9a-f]{24})?#(.+)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OUT_DIR = '.agents';

function preconditionsOf(asset) {
  const found = asset?.preconditions ?? asset?.payload?.preconditions ?? asset?.gene?.preconditions;
  return Array.isArray(found) ? found.filter((entry) => typeof entry === 'string' && entry.startsWith(GIT_PREFIX)) : [];
}

// The directory Evolver installs a pinned skill under: the last segment of its path, or of the repository.
function installNameOf(entry) {
  const pinned = PIN.exec(entry.slice(GIT_PREFIX.length));
  if (!pinned) return null;
  const params = new URLSearchParams(pinned[1]);
  if (!SHA256.test(params.get('sha256') ?? '')) return null;
  const source = params.get('path') || new URL(entry.slice(GIT_PREFIX.length).split('@')[0]).pathname;
  const last = source.split('/').filter(Boolean).pop() ?? '';
  return last.replace(/\.git$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || null;
}

/** The lines that tell the model to install and read the skills `asset` pins; none when it pins none it can name. */
export function requiredSkillLinesOf(asset) {
  const entries = preconditionsOf(asset);
  if (entries.length === 0 || entries.length > MAX_SKILLS || !ASSET_ID.test(asset?.asset_id ?? '')) return [];
  let names;
  try {
    names = entries.map(installNameOf);
  } catch {
    return [];
  }
  if (names.some((name) => !name)) return [];
  const files = names.map((name) => `${OUT_DIR}/skills/${name}/SKILL.md`);
  return [
    `Required skill${names.length > 1 ? 's' : ''} (pinned by this Gene): ${names.join(', ')}. Before acting, install ${names.length > 1 ? 'them' : 'it'} and read ${names.length > 1 ? 'them' : 'it'}:`,
    `- Run: evolver skill fetch --asset ${asset.asset_id} --out ${OUT_DIR} --write --force`,
    `- Read ${files.join(' and ')} and follow ${names.length > 1 ? 'them' : 'it'} with the steps above.`,
  ];
}
