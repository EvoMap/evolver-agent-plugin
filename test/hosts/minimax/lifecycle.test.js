import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import profile from '../../../hosts/minimax/profile.js';
import { createDriver } from '../../../lib/agent/driver.js';
import { runBackgroundTasks } from '../../../lib/app/background.js';
import { environmentFor, RESIDENT } from '../../../lib/runtime/environment.js';
import { ownerIsGone } from '../../../lib/runtime/process/owner.js';
import { transcripts } from '../../../lib/runtime/transcripts.js';
import { PROMPT } from '../../app/memory-ports.js';
import { fakeProxy } from '../../helpers/fake-proxy.js';

const GENE = { title: 'Stabilise retries', summary: 'A shared queue client recovers from transient connection failures when its retry limit is removed.', strategy: ['Reproduce the failing check.', 'Remove the fixed retry limit.', 'Run the same verification again.'] };
const DRAFT = { ok: true, status: 'draft', distill_id: 'minimax-draft', quality: { ok: true, score: 6 }, gene: { type: 'Gene', asset_id: `sha256:${'1'.repeat(64)}` }, capsule: { type: 'Capsule', asset_id: `sha256:${'2'.repeat(64)}` } };

async function fixture({ failFirst = false } = {}) {
  const proxy = await fakeProxy({ distillAnswer: DRAFT });
  const project = join(proxy.env.HOME, 'project'); mkdirSync(project);
  const file = join(project, 'fixture.txt'); writeFileSync(file, 'before');
  const host = spawn(process.execPath, ['-e', 'setInterval(()=>{},60000)'], { windowsHide: true, stdio: 'ignore' });
  await once(host, 'spawn');
  let owner = host.pid, calls = 0;
  const nativeData = join(proxy.env.HOME, 'native');
  const env = { ...proxy.env, MINIMAX_DATA_DIR: nativeData, PLUGIN_DATA: join(nativeData, 'v2', 'plugin-data', 'hooks', 'evolver-plugin') };
  const { ports } = environmentFor({ profile, env, lifetime: RESIDENT, runBackground: runBackgroundTasks, overrides: {
    owner: { current: () => owner, self: () => process.pid, isGone: ownerIsGone },
    model: { complete: async () => { calls += 1; if (failFirst && calls === 1) throw new Error('transient model failure'); return { answer: JSON.stringify(GENE), usage: null }; } },
    engine: { needsSetup: async () => false, takeUnannounced: async () => null },
  } });
  const driver = createDriver({ profile, ports, transcripts, env, lifetime: RESIDENT });
  const payload = (session, turn) => ({ session_id: session, turn_id: turn, cwd: project, model: 'native-bare-model' });
  const hook = (event, session = 's1', turn = 't1', extra = {}) => driver.handle(event, { ...payload(session, turn), ...extra });
  const idle = () => ports.scheduler.idle();
  const killHost = async () => { const ended = once(host, 'close'); host.kill(); await ended; owner = process.pid; assert.equal(ownerIsGone(host.pid), true); };
  const verified = async () => {
    await hook('SessionStart'); await idle();
    const answer = await hook('UserPromptSubmit', 's1', 't1', { prompt: PROMPT });
    assert.match(answer.hookSpecificOutput.additionalContext, /Evolution Memory/);
    const edit = { tool_name: 'edit', tool_input: { file_path: file, old_string: 'before', new_string: 'after' } };
    await hook('PreToolUse', 's1', 't1', edit); writeFileSync(file, 'after');
    await hook('PostToolUse', 's1', 't1', { ...edit, tool_response: { details: { diff: '-before\n+after' } } });
    await hook('PostToolUse', 's1', 't1', { tool_name: 'bash', tool_input: { command: 'node --test' }, tool_response: { details: { execution: { reason: 'exited', exitCode: 0 }, processOutput: { stdout: '# pass 1\n# fail 0', stderr: '', interrupted: false } } } });
    await hook('Stop', 's1', 't1', { last_assistant_message: 'Retries fixed and verification passes.' }); await idle();
    assert.equal((await ports.candidates.read()).s1.pid, host.pid);
  };
  const close = async () => {
    await idle(); ports.scheduler.stop();
    if (host.exitCode === null && host.signalCode === null) { const ended = once(host, 'close'); host.kill(); await ended; }
    proxy.close();
  };
  return { proxy, ports, hook, idle, verified, killHost, close, calls: () => calls };
}

test('a dead native owner is recovered without SessionEnd, distilled once and kept as an unpublished draft', async () => {
  const f = await fixture();
  try {
    await f.verified();
    await f.hook('SessionStart', 'still-live'); await f.idle();
    assert.equal(f.calls(), 0, 'an idle live host does not lose its candidate');
    await f.killHost();
    await f.hook('SessionStart', 'recovery'); await f.idle();
    assert.equal(f.calls(), 1);
    assert.equal((await f.ports.candidates.read()).s1, undefined);
    assert.equal((await f.ports.drafts.read()).length, 1);
    const posted = f.proxy.requests.filter(x => x.path === '/conversation/distill');
    assert.equal(posted.length, 1);
    assert.equal(posted[0].body.publish, false);
    assert.equal(posted[0].body.persist, true, 'the core verifier decides local persistence; publication remains explicit');
    assert.equal(f.proxy.requests.some(x => x.path === '/asset/submit'), false);
    await f.hook('SessionStart', 'recovery-again'); await f.idle();
    assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});

test('a failed recovered completion releases its claim and succeeds at the next start without lowering validation', async () => {
  const f = await fixture({ failFirst: true });
  try {
    await f.verified(); await f.killHost();
    await f.hook('SessionStart', 'retry-one'); await f.idle();
    const due = (await f.ports.candidates.read()).s1;
    assert.equal(due.attempts, 1);
    assert.equal(due.claimedBy, null);
    assert.equal((await f.ports.drafts.read()).length, 0);
    await f.hook('SessionStart', 'retry-two'); await f.idle();
    assert.equal(f.calls(), 2);
    assert.equal((await f.ports.drafts.read()).length, 1);
  } finally { await f.close(); }
});

test('a turn without Stop is closed as an error and late tool output cannot verify the next turn', async () => {
  const f = await fixture();
  try {
    await f.hook('UserPromptSubmit', 's1', 'old', { prompt: PROMPT });
    await f.hook('UserPromptSubmit', 's1', 'new', { prompt: 'Continue after cancellation.' });
    await f.hook('PostToolUse', 's1', 'old', { tool_name: 'bash', tool_input: { command: 'node --test' }, tool_response: { details: { execution: { reason: 'exited', exitCode: 0 } } } });
    await f.hook('Stop', 's1', 'new', { last_assistant_message: 'No verification ran for this new turn.' }); await f.idle();
    assert.deepEqual(await f.ports.candidates.read(), {});
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});
