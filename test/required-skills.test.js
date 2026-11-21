import assert from 'node:assert/strict';
import { test } from 'node:test';

import { recallStrategy } from '../lib/recall.js';
import { requiredSkillLinesOf } from '../lib/required-skills.js';
import { recipeSearchAnswer } from './helpers/recipe-search.js';

const ID = `sha256:${'a'.repeat(64)}`;
const PIN = `skill:git+https://github.com/EvoMap/gene-skills@${'b'.repeat(40)}#sha256=${'c'.repeat(64)}&path=skills/Quest_Gate`;
const STRATEGY = ['Measure the failure rate first.', 'Add jittered backoff.', 'Cap the retries.', 'Alert on the cap.'];
const GENE = { asset_id: ID, asset_type: 'Gene', summary: 'Retry the upload with backoff.', strategy: STRATEGY, preconditions: ['node >= 22', PIN] };

const proxyOf = (assets, recipes = []) => async (method, path, body) => {
  if (path === '/recipe/search') return { ok: true, data: recipeSearchAnswer(recipes, body) };
  if (body?.asset_ids) return { ok: true, data: { assets: assets.filter((asset) => body.asset_ids.includes(asset.asset_id)) } };
  return { ok: true, data: { assets } };
};

test('a pinned skill is named with the command that installs it and the file to read', () => {
  const lines = requiredSkillLinesOf(GENE);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Required skill \(pinned by this Gene\): quest-gate\. Before acting, install it and read it:$/);
  assert.equal(lines[1], `- Run: evolver skill fetch --asset ${ID} --out .agents --write --force`);
  assert.equal(lines[2], '- Read .agents/skills/quest-gate/SKILL.md and follow it with the steps above.');
});

test('a skill pinned at the repository root takes the repository name', () => {
  const root = { ...GENE, preconditions: [`skill:git+https://github.com/EvoMap/report-builder.git@${'b'.repeat(40)}#sha256=${'c'.repeat(64)}`] };
  assert.match(requiredSkillLinesOf(root).at(-1), /\.agents\/skills\/report-builder\/SKILL\.md/);
});

test('a skill that follows a branch is named as the latest on that branch, not as pinned', () => {
  const branch = `skill:git+https://github.com/EvoMap/gene-skills@release/v2#path=skills/Quest_Gate`;
  const lines = requiredSkillLinesOf({ ...GENE, preconditions: [branch, PIN.replace('skills/Quest_Gate', 'skills/report')] });
  assert.equal(lines[0], 'Required skills for this Gene: quest-gate (latest on branch release/v2), report (pinned). Before acting, install them and read them:');
  assert.equal(lines[1], `- Run: evolver skill fetch --asset ${ID} --out .agents --write --force`);
  assert.equal(lines[2], '- Read .agents/skills/quest-gate/SKILL.md and .agents/skills/report/SKILL.md and follow them with the steps above.');
});

test('a branch reference with a digest, a commit without one, or a branch name git could misread names no skill', () => {
  const at = (rev, fragment = 'path=skills/x') => ({ ...GENE, preconditions: [`skill:git+https://github.com/EvoMap/gene-skills@${rev}#${fragment}`] });
  assert.deepEqual(requiredSkillLinesOf(at('main', `sha256=${'c'.repeat(64)}&path=skills/x`)), []);
  assert.deepEqual(requiredSkillLinesOf(at('b'.repeat(40))), []);
  assert.deepEqual(requiredSkillLinesOf(at('--upload-pack=x')), []);
  assert.deepEqual(requiredSkillLinesOf(at('main/../../tags/v1')), []);
});

test('a Gene without a pin, a malformed pin, or an id unsafe for a shell names no skill', () => {
  assert.deepEqual(requiredSkillLinesOf({ ...GENE, preconditions: ['skill: knows git'] }), []);
  assert.deepEqual(requiredSkillLinesOf({ ...GENE, preconditions: [PIN.replace('#sha256', '#md5')] }), []);
  assert.deepEqual(requiredSkillLinesOf({ ...GENE, asset_id: 'sha256:abc; rm -rf ~' }), []);
  assert.deepEqual(requiredSkillLinesOf({ ...GENE, preconditions: undefined }), []);
});

test('two pinned skills are both named, read under the payload envelope too', () => {
  const second = PIN.replace('skills/Quest_Gate', 'skills/report');
  const lines = requiredSkillLinesOf({ asset_id: ID, payload: { preconditions: [PIN, second] } });
  assert.match(lines[0], /^Required skills \(pinned by this Gene\): quest-gate, report\./);
  assert.match(lines.join('\n'), /Read \.agents\/skills\/quest-gate\/SKILL\.md and \.agents\/skills\/report\/SKILL\.md/);
});

test('an injected strategy carries its pinned skill after the steps, whatever the step budget cut', async () => {
  const long = [...Array.from({ length: 14 }, (step, index) => `${'x'.repeat(380)} step ${index}.`)];
  const match = await recallStrategy(proxyOf([{ ...GENE, strategy: long }]), 'add a retry to the uploader');
  assert.match(match.text, /left out for length\.\)\nRequired skill \(pinned by this Gene\): quest-gate\./);
  assert.match(match.text, /--asset sha256:a{64} --out \.agents --write --force\n- Read \.agents\/skills\/quest-gate\/SKILL\.md/);
  assert.match(match.text, /\n\nApply them where they fit\.|Evolver reports how the reuse/);
});

test('a strategy without a pin is injected as before', async () => {
  const match = await recallStrategy(proxyOf([{ ...GENE, preconditions: [] }]), 'add a retry to the uploader');
  assert.doesNotMatch(match.text, /Required skill/);
});

test('a Recipe step names the skill its Gene pins', async () => {
  const other = { asset_id: `sha256:${'d'.repeat(64)}`, short_title: 'Alert on exhausted retries', strategy: ['Count exhausted retries', 'Page when the rate climbs'] };
  const recipe = { id: 'rcp_upload', title: 'Harden a flaky upload client', steps: [{ asset_id: ID, position: 1 }, { asset_id: other.asset_id, position: 2 }] };
  const match = await recallStrategy(proxyOf([{ ...GENE, short_title: 'Retry with jittered backoff' }, other], [recipe]), 'set up retry with backoff for the flaky upload client',
    { context: { task: 'set up retry with backoff for the flaky upload client', trigger: 'turn_start' } });
  assert.deepEqual(match.ids, [ID, other.asset_id]);
  assert.match(match.text, /4\. Alert on the cap\.\nRequired skill \(pinned by this Gene\): quest-gate\.[\s\S]*\n\nStep 2 — Alert on exhausted retries:/);
  // Each step's own text is what the session ledger keeps for the turn's reuse report: it names the skill too.
  assert.match(match.stepTexts[ID], /^4\. Alert on the cap\.\nRequired skill \(pinned by this Gene\): quest-gate\./m);
  assert.doesNotMatch(match.stepTexts[other.asset_id], /Required skill/);
});

test('a Gene that pins a skill needs no four steps: the skill carries the detail', async () => {
  const thin = { ...GENE, strategy: ['Install and read the pinned skill before anything else.', 'Build the quest core the skill describes.'] };
  const match = await recallStrategy(proxyOf([thin]), 'add a retry to the uploader');
  assert.deepEqual(match.ids, [ID]);
  assert.match(match.text, /^2\. Build the quest core the skill describes\.\nRequired skill \(pinned by this Gene\): quest-gate\./m);
});

test('a two-step Gene without a pin still gives way to one that fits', async () => {
  const thin = { ...GENE, asset_id: `sha256:${'e'.repeat(64)}`, preconditions: [], strategy: ['Install nothing at all here, please.', 'Then do the work as usual today.'], similarity: 0.9 };
  const full = { ...GENE, preconditions: [], similarity: 0.5 };
  const match = await recallStrategy(proxyOf([thin, full]), 'add a retry to the uploader');
  assert.deepEqual(match.ids, [ID]);
});
