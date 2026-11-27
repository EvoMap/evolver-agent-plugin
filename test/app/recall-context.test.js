import assert from 'node:assert/strict';
import { test } from 'node:test';

import { promptSubmitted } from '../../lib/app/prompt.js';
import { sessionEnded } from '../../lib/app/session-end.js';
import { toolFinished } from '../../lib/app/tool-result.js';
import { turnEnded } from '../../lib/app/turn-end.js';
import { memoryPorts } from './memory-ports.js';

const fetchContexts = (requests) => requests.filter(({ path }) => path === '/asset/fetch').map(({ body }) => body.context);

async function turn(ports, prompt, answer, options = {}) {
  await promptSubmitted(ports, { sessionId: 's', prompt, waitMs: 5_000, ...options });
  if (answer !== undefined) await turnEnded(ports, { sessionId: 's', reason: 'answer', answer });
}

test('a recall carries the turns before it, each prompt then its answer, and the first prompt carries none', async () => {
  const { ports, requests } = memoryPorts();
  await turn(ports, 'Distill the nexu-io sources into Genes', '56 sources: 12 published, 114 assets, 1 quarantined by the Hub.');
  await turn(ports, 'Report progress', 'All 56 published; 704 assets in all.');
  await turn(ports, 'How many assets in all? Report after the evaluation');
  const [first, second, third] = fetchContexts(requests);
  assert.equal(first.recent_turns, undefined);
  assert.deepEqual(second.recent_turns, [
    { role: 'user', text: 'Distill the nexu-io sources into Genes' },
    { role: 'assistant', text: '56 sources: 12 published, 114 assets, 1 quarantined by the Hub.' },
  ]);
  assert.equal(third.recent_turns.length, 4);
  assert.deepEqual(third.recent_turns.at(-1), { role: 'assistant', text: 'All 56 published; 704 assets in all.' });
  assert.equal(third.task, 'Distill the nexu-io sources into Genes', 'the task stays the session\'s first prompt');
});

test('only the last three turns are kept, and a turn that ended without an answer keeps its prompt', async () => {
  const { ports, requests } = memoryPorts();
  for (const mark of ['one', 'two', 'three', 'four']) await turn(ports, `Prompt ${mark} for the uploader`, `Answer ${mark}`);
  await turn(ports, 'Prompt five for the uploader', '');
  await turn(ports, 'Prompt six for the uploader');
  const texts = fetchContexts(requests).at(-1).recent_turns.map(({ text }) => text);
  assert.deepEqual(texts, ['Prompt three for the uploader', 'Answer three', 'Prompt four for the uploader', 'Answer four', 'Prompt five for the uploader']);
});

test('the host\'s latest title rides every recall, and a prompt that names none keeps the last one', async () => {
  const { ports, requests } = memoryPorts();
  await turn(ports, 'Distill openmotion for dsh', 'Done.', { title: 'Distill openmotion' });
  await turn(ports, 'Now the nexu-io sources', 'Started.', { title: 'Distill openmotion and nexu-io' });
  await turn(ports, 'How many assets in all?');
  const [first, second, third] = fetchContexts(requests);
  assert.equal(first.title, 'Distill openmotion');
  assert.equal(second.title, 'Distill openmotion and nexu-io');
  assert.equal(third.title, 'Distill openmotion and nexu-io');
});

test('a prompt that opens the next turn right after this one opened lends this recall no title or recent turns', async () => {
  const { ports, requests } = memoryPorts();
  await turn(ports, 'Add retries to the uploader client', 'Added, capped at five.', { title: 'Uploader retries' });
  await turnEnded(ports, { sessionId: 's', reason: 'answer', answer: '' });
  const update = ports.sessions.update;
  const read = ports.sessions.read;
  let opened = false;
  let interleaved = false;
  ports.sessions.update = async (...args) => {
    const result = await update(...args);
    opened = true;
    return result;
  };
  ports.sessions.read = async (...args) => {
    if (opened && !interleaved) {
      interleaved = true;
      await promptSubmitted(ports, { sessionId: 's', prompt: 'Unrelated: rename the module', waitMs: 0, title: 'Renaming the module' });
    }
    return read(...args);
  };
  await promptSubmitted(ports, { sessionId: 's', prompt: 'Now cap the retries at three', waitMs: 5_000, title: 'Uploader retries' });
  const forThisTurn = fetchContexts(requests).find((context) => context.task === 'Add retries to the uploader client' && context.title === 'Uploader retries' && context.recent_turns?.length === 2);
  assert.ok(forThisTurn, 'this turn\'s recall carries the session as this turn opened it');
});

test('a typed command is not a recent turn', async () => {
  const { ports, requests } = memoryPorts();
  await turn(ports, 'Add retries to the uploader client', 'Added, capped at five.');
  await promptSubmitted(ports, { sessionId: 's', prompt: '/evolver-status', isCommand: true, waitMs: 5_000 });
  await turn(ports, 'Now cap the retries at three');
  assert.deepEqual(fetchContexts(requests).at(-1).recent_turns, [
    { role: 'user', text: 'Add retries to the uploader client' },
    { role: 'assistant', text: 'Added, capped at five.' },
  ]);
});

test('a host that tells the answer among its tool notes, not at the turn end, still has it recalled with', async () => {
  const { ports, requests } = memoryPorts();
  await turn(ports, 'Summarise the failing uploads');
  await toolFinished(ports, { sessionId: 's', note: { kind: 'answer', text: 'Three uploads failed on a 413.' } });
  await turnEnded(ports, { sessionId: 's', reason: 'answer' });
  await turn(ports, 'Fix those');
  assert.deepEqual(fetchContexts(requests).at(-1).recent_turns.at(-1), { role: 'assistant', text: 'Three uploads failed on a 413.' });
});

test('a re-judged host turn keeps its newest answer even if another record has none', async () => {
  const { ports, requests } = memoryPorts();
  await turn(ports, 'Add retries to the uploader client', undefined, { turnId: 'first' });
  const endWithRecord = (answer) => turnEnded(ports, {
    sessionId: 's', turnId: 'first', reason: 'answer',
    recordOf: () => ({ checks: [], commands: [], paths: [], edits: [], answer }),
  });

  await endWithRecord('The check is still running.');
  await endWithRecord('The check passed after the background run.');
  await endWithRecord('');
  await turn(ports, 'Summarize the check result');

  assert.deepEqual(fetchContexts(requests).at(-1).recent_turns, [
    { role: 'user', text: 'Add retries to the uploader client' },
    { role: 'assistant', text: 'The check passed after the background run.' },
  ]);
});

test('a turn nobody typed for keeps neither its own answer nor the typed turn before it from the recent turns', async () => {
  const { ports, requests } = memoryPorts();
  await turn(ports, 'Distill the nexu-io sources into Genes', '56 sources queued.');
  await promptSubmitted(ports, { sessionId: 's', prompt: null, waitMs: 5_000 });
  await turnEnded(ports, { sessionId: 's', reason: 'answer', answer: 'The background job finished.' });
  await turn(ports, 'How many assets in all?');
  assert.deepEqual(fetchContexts(requests).at(-1).recent_turns, [
    { role: 'user', text: 'Distill the nexu-io sources into Genes' },
    { role: 'assistant', text: '56 sources queued.' },
  ]);
});

test('a resumed session keeps its recent turns and title, the last turn before the end among them', async () => {
  const { ports, requests } = memoryPorts();
  await turn(ports, 'Distill openmotion for dsh', 'Published 8 Genes.', { title: 'Distill openmotion' });
  await sessionEnded(ports, { sessionId: 's', projectDir: null });
  await turn(ports, 'Now evaluate their recall');
  const context = fetchContexts(requests).at(-1);
  assert.deepEqual(context.recent_turns, [
    { role: 'user', text: 'Distill openmotion for dsh' },
    { role: 'assistant', text: 'Published 8 Genes.' },
  ]);
  assert.equal(context.title, 'Distill openmotion');
  assert.equal(context.task, 'Distill openmotion for dsh');
});

test('overlapping re-judges in one clock tick retain the newest answer', async (t) => {
  for (const middleSettles of [false, true]) {
    await t.test(middleSettles ? 'a newer re-judge already settled' : 'both re-judges are still pending', async () => {
      const { ports, requests } = memoryPorts();
      await turn(ports, 'Add retries to the uploader client', undefined, { turnId: 'first' });
      const record = (answer) => ({ checks: [], commands: [], paths: [], edits: [], answer });
      const endWith = (read) => turnEnded(ports, {
        sessionId: 's', turnId: 'first', reason: 'answer', recordOf: read,
      });
      await endWith(() => record('The initial test is running.'));

      async function deferredEnd(answer) {
        const reading = Promise.withResolvers(), result = Promise.withResolvers();
        const work = endWith(() => { reading.resolve(); return result.promise; });
        await reading.promise;
        return async () => {
          result.resolve(record(answer));
          await work;
        };
      }

      const settleOlder = await deferredEnd('The older run still showed a pending check.');
      if (middleSettles) await endWith(() => record('The second run completed.'));
      const settleNewest = await deferredEnd('The newest run confirmed the check passed.');
      await settleOlder();
      await settleNewest();
      await turn(ports, 'Summarize the check result');

      assert.deepEqual(fetchContexts(requests).at(-1).recent_turns.at(-1), {
        role: 'assistant', text: 'The newest run confirmed the check passed.',
      });
    });
  }
});

test('a superseded re-judge cannot replace, remove or restore the candidate', async (t) => {
  for (const [name, oldWork, newWork] of [
    ['replace newer work', true, true],
    ['remove newer work', false, true],
    ['restore work the newer record removed', true, false],
  ]) {
    await t.test(name, async () => {
      const { ports } = memoryPorts();
      const record = (answer, work) => ({
        checks: work ? [{ command: 'npm test', failed: false }] : [],
        commands: work ? ['npm test'] : [], paths: [], edits: [], answer,
      });
      const endWith = (read) => turnEnded(ports, {
        sessionId: 's', turnId: 'first', reason: 'answer', recordOf: read,
      });
      await turn(ports, 'Add retries to the uploader client', undefined, { turnId: 'first' });
      await endWith(() => record('Original result.', true));
      const reading = Promise.withResolvers(), older = Promise.withResolvers();
      const stale = endWith(() => { reading.resolve(); return older.promise; });
      await reading.promise;
      await endWith(() => record('Newer result.', newWork));
      older.resolve(record('Older result.', oldWork));
      await stale;

      const candidate = (await ports.candidates.read()).s;
      if (newWork) assert.equal(candidate?.turns[0].answer, 'Newer result.');
      else assert.equal(candidate, undefined);
    });
  }
});

test('a candidate mutation is fenced against a re-judge that starts after its state read', async () => {
  const { ports } = memoryPorts();
  let lifecycle = Promise.resolve();
  ports.sessions.withCandidate = (_sessionId, update) => {
    const next = lifecycle.then(update);
    lifecycle = next.catch(() => {});
    return next;
  };
  await turn(ports, 'Add retries to the uploader client', undefined, { turnId: 'first' });
  const endWith = (answer, failed) => turnEnded(ports, {
    sessionId: 's', turnId: 'first', reason: 'answer',
    recordOf: () => ({ checks: [{ command: 'npm test', failed }], commands: ['npm test'], paths: [], edits: [], answer }),
  });
  await endWith('The initial test ran.', true);

  const olderReachedWrite = Promise.withResolvers(), releaseOlder = Promise.withResolvers();
  const save = ports.candidates.update;
  let pauseOnce = true;
  ports.candidates.update = async (mutate) => {
    if (pauseOnce) {
      pauseOnce = false;
      olderReachedWrite.resolve();
      await releaseOlder.promise;
    }
    return save(mutate);
  };

  const old = endWith('The older failed record is stale.', true);
  await olderReachedWrite.promise;
  const newer = endWith('The latest record passed.', false);
  await new Promise((resolve) => setImmediate(resolve));
  releaseOlder.resolve();
  await Promise.all([old, newer]);

  assert.equal((await ports.candidates.read()).s.turns[0].answer, 'The latest record passed.');
});

test('a late first completion cannot replace or restore a re-judged candidate', async (t) => {
  for (const rejudgedWork of [true, false]) {
    await t.test(rejudgedWork ? 'replace newer work' : 'restore removed work', async () => {
      const { ports } = memoryPorts();
      const record = (answer, work) => ({
        checks: work ? [{ command: 'npm test', failed: false }] : [],
        commands: work ? ['npm test'] : [], paths: [], edits: [], answer,
      });
      const endWith = (read) => turnEnded(ports, {
        sessionId: 's', turnId: 'first', reason: 'answer', recordOf: read,
      });
      await turn(ports, 'Add retries to the uploader client', undefined, { turnId: 'first' });
      const reading = Promise.withResolvers(), older = Promise.withResolvers();
      const initial = endWith(() => { reading.resolve(); return older.promise; });
      await reading.promise;
      await endWith(() => record('Re-judged result.', rejudgedWork));
      older.resolve(record('Initial result arrived late.', true));
      await initial;

      const candidate = (await ports.candidates.read()).s;
      if (rejudgedWork) assert.equal(candidate?.turns[0].answer, 'Re-judged result.');
      else assert.equal(candidate, undefined);
    });
  }
});

test('a failed re-judge cleanup leaves its newest answer available to recall', async () => {
  const { ports, requests } = memoryPorts();
  const endWith = (answer) => turnEnded(ports, {
    sessionId: 's', turnId: 'first', reason: 'answer',
    recordOf: () => ({ checks: [{ command: 'npm test', failed: false }], commands: ['npm test'], paths: [], edits: [], answer }),
  });
  await turn(ports, 'Add retries to the uploader client', undefined, { turnId: 'first' });
  await endWith('Original check result.');

  const write = ports.sessions.update;
  const busy = Object.assign(new Error('fixture state writer busy'), { code: 'ELOCKED' });
  let cleanupFailed = false;
  ports.sessions.update = (sessionId, mutate) => write(sessionId, (current) => {
    const next = mutate(current);
    if (!cleanupFailed && Number.isFinite(current.settling) && next?.settling === null) {
      cleanupFailed = true;
      throw busy;
    }
    return next;
  });

  await assert.rejects(endWith('Newest check result.'), busy);
  assert.equal((await ports.candidates.read()).s.turns[0].answer, 'Newest check result.');
  await ports.clock.sleep(30_001);
  await turn(ports, 'Summarize the check result');
  assert.equal(fetchContexts(requests).at(-1).recent_turns.at(-1).text, 'Newest check result.');
});
