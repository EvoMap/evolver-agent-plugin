// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// A Gene names a skill it needs as one `preconditions` entry, either pinned to a commit and its content digest
// (Evolver 2.0.54 and later) or following a branch (Evolver releases that accept branch references):
//   skill:git+https://github.com/owner/repo@<commit>#sha256=<digest>&path=<dir>
//   skill:git+https://github.com/owner/repo@<branch>#path=<dir>
// The plugin gives the model no tools, so it names the skill with the Evolver command that installs it. Evolver
// fetches the commit (or the branch's latest) and checks the digest; this only reads which skills there are and where
// they land, and accepts a reference only in the shapes Evolver accepts.
import { linesCostOf } from './token-budget.js';

const GIT_PREFIX = 'skill:git+';
const MAX_SKILLS = 8;
export const MAX_SKILL_TOKENS = 200;
const ASSET_ID = /^sha256:[0-9a-f]{64}$/;
const REFERENCE = /^(https:\/\/[^\s#@]+)@([^\s#@]+)(?:#(.*))?$/;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BRANCH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_BRANCH_LENGTH = 200;
const OUT_DIR = '.agents';

function preconditionsOf(asset) {
  const found = asset?.preconditions ?? asset?.payload?.preconditions ?? asset?.gene?.preconditions;
  return Array.isArray(found) ? found.filter((entry) => typeof entry === 'string' && entry.startsWith(GIT_PREFIX)) : [];
}

// The same branch names Evolver fetches as refs/heads/<name>: plain characters, no `..`, no empty, dot-led or
// `.lock` segment, and no leading `-`.
function isBranchName(name) {
  return name.length <= MAX_BRANCH_LENGTH && !name.startsWith('-') && !name.includes('..') && !name.endsWith('.')
    && name.split('/').every((segment) => BRANCH_SEGMENT.test(segment) && !segment.startsWith('.') && !segment.endsWith('.lock'));
}

// The directory Evolver installs a skill under (the last segment of its path, or of the repository) and the branch
// it follows, if it does not pin a commit. A commit needs a digest; a branch takes none.
function requiredSkillOf(entry) {
  const reference = REFERENCE.exec(entry.slice(GIT_PREFIX.length));
  if (!reference) return null;
  const [, repo, rev, fragment = ''] = reference;
  const params = new URLSearchParams(fragment);
  // Evolver refuses a fragment key it does not know, so naming such a skill would only hand the model a failing command.
  if ([...params.keys()].some((key) => key !== 'sha256' && key !== 'path')) return null;
  const sha256 = params.get('sha256');
  const pinned = COMMIT.test(rev) && SHA256.test(sha256 ?? '');
  if (!pinned && (sha256 !== null || COMMIT.test(rev) || !isBranchName(rev))) return null;
  const source = params.get('path') || new URL(repo).pathname;
  const last = source.split('/').filter(Boolean).pop() ?? '';
  const name = last.replace(/\.git$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return name ? { name, branch: pinned ? null : rev } : null;
}

function renderSkillLines(assetId, skills) {
  const names = skills.map((skill) => skill.name);
  const files = names.map((name) => `${OUT_DIR}/skills/${name}/SKILL.md`);
  // A skill that follows a branch is whatever the branch holds at install time, so it is not called pinned.
  const heading = skills.every((skill) => !skill.branch)
    ? `(pinned by this Gene): ${names.join(', ')}`
    : `for this Gene: ${skills.map((skill) => `${skill.name} (${skill.branch ? `latest on branch ${skill.branch}` : 'pinned'})`).join(', ')}`;
  const readLine = names.length > 2
    ? `- Read only the needed section of ${files.join(', ')} and follow them with the steps above.`
    : `- Read ${files.join(' and ')} and follow ${names.length > 1 ? 'them' : 'it'} with the steps above.`;
  return [
    `Required skill${names.length > 1 ? 's' : ''} ${heading}. Before acting, install ${names.length > 1 ? 'them' : 'it'} and read ${names.length > 1 ? 'them' : 'it'}:`,
    `- Run: evolver skill fetch --asset ${assetId} --out ${OUT_DIR} --write --force`,
    readLine,
  ];
}

/** The lines that tell the model to install and read the skills `asset` requires; none when it names none it can use. */
export function requiredSkillLinesOf(asset, { maxTokens = MAX_SKILL_TOKENS } = {}) {
  const entries = preconditionsOf(asset);
  if (entries.length === 0 || entries.length > MAX_SKILLS || !ASSET_ID.test(asset?.asset_id ?? '') || maxTokens <= 0) return [];
  let skills;
  try {
    skills = entries.map(requiredSkillOf);
  } catch {
    return [];
  }
  if (skills.some((skill) => !skill)) return [];
  for (let count = skills.length; count >= 1; count -= 1) {
    const lines = renderSkillLines(asset.asset_id, skills.slice(0, count));
    if (linesCostOf(lines) <= maxTokens) return lines;
  }
  return [];
}
