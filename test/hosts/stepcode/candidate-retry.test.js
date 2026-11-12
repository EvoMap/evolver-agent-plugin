import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { PROMPT, requestsTo, stepHost, until } from './host.js';

async function nativeTurn(t) {
  const host = await stepHost(t);
  await host.emit('session_start');
  await host.emit('before_agent_start', { prompt: PROMPT, systemPrompt: 'Base instructions.' });
  await host.emit('agent_start');
  const opened = await host.stores.sessions.read('native-step-session');
  const file = join(host.ctx.cwd, 'retry.json');
  fs.writeFileSync(file, '{"retries":0}');
  const edit = { toolName: 'write_file', toolCallId: 'edit-1', input: { path: 'retry.json', content: '{"retries":2}' } };
  await host.emit('tool_call', edit);
  fs.writeFileSync(file, edit.input.content);
  await host.emit('tool_result', { ...edit, details: { changed: true }, isError: false,
    content: [{ type: 'text', text: 'File updated.' }] });
  const call = { toolName: 'run_command', toolCallId: 'check-1', input: { command: 'node --test' } };
  await host.emit('tool_call', call);
  await host.emit('tool_result', { ...call, details: { execution: { status: 'exited', exitCode: 0 } }, isError: false,
    content: [{ type: 'text', text: '# pass 1\n# fail 0' }] });
  const answer = 'Bounded Redis retries and teardown passed the original native check.';
  await host.emit('turn_end', { turnIndex: 0, message: {
    role: 'assistant', content: [{ type: 'text', text: answer }], stopReason: 'stop',
  } });
  const state = join(host.proxy.env.HOME, 'agent', 'evolver-plugin');
  const target = join(state, 'stepcode-distill-ranges.json');
  return { host, opened, file, answer, state, target };
}

async function recoveredCandidate({ host, opened, file, answer, state }) {
  await until(async () => {
    const range = (await host.stores.candidates.read())['native-step-session'];
    const session = await host.stores.sessions.read('native-step-session');
    return Boolean(range) && session.open === false && session.settling == null;
  }, 'automatic recovery of the settled candidate');
  await until(() => requestsTo(host, '/asset/reuse-result').length === 2, 'one report for each Recipe step');

  const range = (await host.stores.candidates.read())['native-step-session'];
  assert.equal(range.sessionEpoch, opened.sessionEpoch);
  assert.equal(range.turns.length, 1);
  assert.equal(range.turns[0].turn, opened.turn);
  assert.equal(range.turns[0].prompt, PROMPT);
  assert.equal(range.turns[0].answer, answer);
  assert.deepEqual(range.turns[0].steps, [
    { kind: 'edit', path: file }, { kind: 'edit', path: file },
    { kind: 'check', command: 'node --test', exit: 0, failed: false },
  ]);
  assert.deepEqual(range.model, opened.turnStart);
  assert.deepEqual(range.model.selection, { providerId: 'fixture', modelId: 'fixture-model', variant: 'off' });
  const closed = await host.stores.sessions.read('native-step-session');
  assert.equal(closed.turnId, opened.turnId);
  assert.equal(closed.turn, opened.turn);
  assert.equal(closed.open, false);
  assert.deepEqual(requestsTo(host, '/asset/reuse-result').map(({ body }) => [body.task_id, body.outcome]), [
    ['stepcode:native-step-session:1', 'success'], ['stepcode:native-step-session:1', 'success'],
  ]);
  const notes = await host.stores.notes.take('native-step-session', opened);
  assert.deepEqual(notes.notes, []);
  await notes.commit();
  const baseline = await host.stores.baseline.take('native-step-session', opened.turnId, opened);
  assert.equal(baseline.before.size, 0);
  await baseline.commit();
  assert.deepEqual(fs.readdirSync(state).filter(name => /^stepcode-(?:turn|edits)-/.test(name) && name.endsWith('.taking')), []);
  assert.deepEqual(host.completion.calls, [], 'recovery does not run another model turn');
  return range;
}

test('Step automatically retries a failed candidate write with the original settled turn proof', async t => {
  const fixture = await nativeTurn(t);
  const { host, target } = fixture;
  const rename = fs.renameSync;
  let refused = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (!refused && to === target && JSON.parse(fs.readFileSync(from, 'utf8'))['native-step-session']?.turns?.length) {
      refused = true;
      throw Object.assign(new Error('fixture candidate replacement failed once'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  await host.emit('agent_settled');
  assert.equal(refused, true, 'the nonempty candidate replacement was actually refused');
  await recoveredCandidate(fixture);
});

test('Step retry after a candidate replacement already landed keeps one candidate and one retention record', async t => {
  const fixture = await nativeTurn(t);
  const { host, target, state } = fixture;
  const rename = fs.renameSync;
  let refused = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    const fail = !refused && to === target && JSON.parse(fs.readFileSync(from, 'utf8'))['native-step-session']?.turns?.length;
    const result = rename(from, to);
    if (fail) {
      refused = true;
      throw Object.assign(new Error('fixture candidate replacement landed before the error'), { code: 'EIO' });
    }
    return result;
  });
  await host.emit('agent_settled');
  assert.equal(refused, true);
  await recoveredCandidate(fixture);
  const entries = fs.readFileSync(join(state, 'stepcode-retention-pending.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].reuses.length, 2);
});

test('Step bounds a persistent candidate write failure to three attempts and preserves its evidence with a warning', async t => {
  const { host, target, opened, file } = await nativeTurn(t);
  const rename = fs.renameSync;
  let refused = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === target && JSON.parse(fs.readFileSync(from, 'utf8'))['native-step-session']?.turns?.length) {
      refused++;
      throw Object.assign(new Error('fixture persistent candidate write refusal'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  await host.emit('agent_settled');
  assert.equal(refused, 3);
  assert.ok(host.notices.some(({ text, kind }) => kind === 'error' && /could not finish saving this turn/.test(text)));
  assert.deepEqual(await host.stores.candidates.read(), {});
  const session = await host.stores.sessions.read('native-step-session');
  assert.equal(session.open, true);
  assert.equal(session.turnId, opened.turnId);
  const notes = await host.stores.notes.take('native-step-session', opened);
  assert.ok(notes.notes.some(note => note.kind === 'shell' && note.exit === 0));
  notes.release();
  const baseline = await host.stores.baseline.take('native-step-session', opened.turnId, opened);
  assert.equal(baseline.before.size, 1);
  assert.ok(baseline.before.has(file));
  baseline.release();
  assert.deepEqual(host.completion.calls, []);
});

test('Step does not retry corrupt candidate state and preserves its bytes and native evidence', async t => {
  const { host, target, opened, file } = await nativeTurn(t);
  fs.writeFileSync(target, '{');
  const read = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (candidate, ...args) => {
    if (candidate === target) reads++;
    return read(candidate, ...args);
  });
  await host.emit('agent_settled');
  assert.equal(reads, 1, 'invalid state is not treated as a transient write failure');
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(target, 'utf8'), '{');
  assert.ok(host.notices.some(({ text, kind }) => kind === 'error' && /could not finish saving this turn/.test(text)));
  const session = await host.stores.sessions.read('native-step-session');
  assert.equal(session.open, true);
  assert.equal(session.turnId, opened.turnId);
  const notes = await host.stores.notes.take('native-step-session', opened);
  assert.ok(notes.notes.some(note => note.kind === 'shell' && note.exit === 0));
  notes.release();
  const baseline = await host.stores.baseline.take('native-step-session', opened.turnId, opened);
  assert.equal(baseline.before.size, 1);
  assert.ok(baseline.before.has(file));
  baseline.release();
  assert.deepEqual(host.completion.calls, []);
});

for (const persisted of [false, true]) {
  test(`a late abort after accepted native completion preserves the verdict when persistence ${persisted ? 'already happened' : 'has not happened'}`, async t => {
    const fixture = await nativeTurn(t);
    const { host, target } = fixture;
    const rename = fs.renameSync;
    let refused = false;
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (!refused && to === target && JSON.parse(fs.readFileSync(from, 'utf8'))['native-step-session']?.turns?.length) {
        refused = true;
        if (persisted) rename(from, to);
        host.abort();
        throw Object.assign(new Error('fixture candidate write refusal after native completion'), { code: 'EIO' });
      }
      return rename(from, to);
    });
    await host.emit('agent_settled');
    assert.equal(refused, true);
    await recoveredCandidate(fixture);
    assert.deepEqual(await host.stores.drafts.read(), []);
  });
}

test('a new prompt waits for the old settled turn retry without replacing its account or closing the new turn', async t => {
  const { host, target, opened, answer, file } = await nativeTurn(t);
  const rename = fs.renameSync;
  let refused = false, nextPrompt;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (!refused && to === target && JSON.parse(fs.readFileSync(from, 'utf8'))['native-step-session']?.turns?.length) {
      refused = true;
      host.auth.apiKey = 'second-fixture-account-key';
      nextPrompt = host.emit('before_agent_start', { prompt: 'Explain a CSS colour.', systemPrompt: 'Base instructions.' });
      // The original promise is awaited below, after the concurrent settlement finishes.
      nextPrompt.catch(() => {});
      throw Object.assign(new Error('fixture candidate replacement failed as the next prompt arrived'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  await host.emit('agent_settled');
  assert.equal(refused, true);
  await nextPrompt;
  await until(() => requestsTo(host, '/asset/reuse-result').length === 2, 'the original Recipe reports');
  const range = (await host.stores.candidates.read())['native-step-session'];
  assert.ok(range, 'the next prompt must not consume the confirmed old turn as an unfinished error');
  assert.equal(range.turns.length, 1);
  assert.equal(range.sessionEpoch, opened.sessionEpoch);
  assert.equal(range.turns[0].turn, opened.turn);
  assert.equal(range.turns[0].answer, answer);
  assert.equal(range.turns[0].prompt, PROMPT);
  assert.deepEqual(range.turns[0].steps, [
    { kind: 'edit', path: file }, { kind: 'edit', path: file },
    { kind: 'check', command: 'node --test', exit: 0, failed: false },
  ]);
  assert.deepEqual(range.model, opened.turnStart, 'the old proof keeps its captured account route');
  const current = await host.stores.sessions.read('native-step-session');
  assert.equal(current.open, true);
  assert.equal(current.turn, opened.turn + 1);
  assert.notEqual(current.turnId, opened.turnId);
  assert.equal(current.prompt, 'Explain a CSS colour.');
  assert.notEqual(current.turnStart.configDigest, opened.turnStart.configDigest, 'the new prompt captures the changed account separately');
  assert.deepEqual(requestsTo(host, '/asset/reuse-result').map(({ body }) => [body.task_id, body.outcome]), [
    ['stepcode:native-step-session:1', 'success'], ['stepcode:native-step-session:1', 'success'],
  ]);
  const notes = await host.stores.notes.take('native-step-session', opened);
  assert.deepEqual(notes.notes, []);
  await notes.commit();
  const baseline = await host.stores.baseline.take('native-step-session', opened.turnId, opened);
  assert.equal(baseline.before.size, 0);
  await baseline.commit();
  assert.deepEqual(host.completion.calls, []);
});
