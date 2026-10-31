import assert from 'node:assert/strict';
import { test } from 'node:test';

import { recallStrategy, promptTextOf } from '../lib/recall.js';

function stubProxy(recalled) {
  const calls = [];
  const searches = [];
  const proxyFetch = async (method, path, body) => {
    if (path === '/recipe/search') {
      searches.push(body);
      return { ok: true, data: [] };
    }
    calls.push({ method, path, body });
    if (recalled instanceof Error) throw recalled;
    return recalled === undefined ? { ok: false, error: 'nope' } : { ok: true, data: recalled };
  };
  return { proxyFetch, calls, searches };
}

const ASSET = {
  asset_id: 'sha256:abc',
  asset_type: 'Gene',
  summary: 'Retry the upload with backoff.',
  strategy: ['  Measure the failure rate first.  ', 'Add jittered backoff.', 'Cap the retries.', 'Alert on the cap.', ''],
  validation: ['npm test'],
};

test('the prompt text is the typed prompt, trimmed and bounded', () => {
  assert.equal(promptTextOf('  add a retry to the uploader  '), 'add a retry to the uploader');
  assert.equal(promptTextOf('x'.repeat(500)).length, 400);
  assert.equal(promptTextOf(undefined), '');
});

test('one call recalls by text and injects that asset\'s strategy alone', async () => {
  const { proxyFetch, calls } = stubProxy({ assets: [ASSET] });
  const { ids, text } = await recallStrategy(proxyFetch, 'add a retry to the uploader');

  assert.deepEqual(calls.map((call) => call.path), ['/asset/fetch']);
  assert.deepEqual(calls[0].body, { text: 'add a retry to the uploader' }, 'no limit: the Hub default applies');
  assert.ok(!('asset_ids' in calls[0].body), 'ids would turn the recall back into a lookup');
  assert.deepEqual(ids, ['sha256:abc']);
  assert.match(text, /\[Evolution Memory\] Retry the upload with backoff\. \(EvoMap network\)/);
  assert.match(text, /Evolver reports how the reuse of sha256:abc went when this turn ends\./);
  assert.match(text, /^1\. Measure the failure rate first\.$/m);
  assert.match(text, /^4\. Alert on the cap\.$/m);
  assert.doesNotMatch(text, /npm test/);
});

test('a bounded prompt reaches the Hub, and a trivial one never does', async () => {
  const long = stubProxy({ assets: [] });
  await recallStrategy(long.proxyFetch, 'x'.repeat(5_000));
  assert.ok(long.calls[0].body.text.length <= 5_000);
  assert.equal('limit' in long.calls[0].body, false);

  const trivial = stubProxy({ assets: [ASSET] });
  assert.deepEqual(await recallStrategy(trivial.proxyFetch, 'hi'), { ids: [], text: '' });
  assert.equal(trivial.calls.length, 0);
});

test('an asset already injected this session is passed over', async () => {
  const { proxyFetch } = stubProxy({
    assets: [ASSET, { asset_id: 'sha256:next', asset_type: 'Capsule', payload: { strategy: ['Drain the queue first.', 'Replay the dead letters.', 'Re-enable the consumer.', 'Watch the depth.'] } }],
  });

  const { ids, text } = await recallStrategy(proxyFetch, 'add a retry to the uploader', {
    listedIds: new Set(['sha256:abc']),
  });

  assert.deepEqual(ids, ['sha256:next']);
  assert.doesNotMatch(text, /sha256:abc|Measure the failure rate/);
  assert.match(text, /\[Evolution Memory\] Capsule \(EvoMap network\)/);
  assert.match(text, /Evolver reports how the reuse of sha256:next went when this turn ends\./);
  assert.match(text, /^1\. Drain the queue first\.$/m);
});

test('a failing Proxy, an empty recall, and a strategy-less asset inject nothing', async () => {
  const down = stubProxy(undefined);
  assert.deepEqual(await recallStrategy(down.proxyFetch, 'add a retry to the uploader'), { ids: [], text: '' });

  const throwing = stubProxy(new Error('socket hang up'));
  assert.deepEqual(await recallStrategy(throwing.proxyFetch, 'add a retry to the uploader'), { ids: [], text: '' });

  const empty = stubProxy({ assets: [] });
  assert.deepEqual(await recallStrategy(empty.proxyFetch, 'add a retry to the uploader'), { ids: [], text: '' });

  const hollow = stubProxy({ assets: [{ asset_id: 'sha256:abc', summary: 'only prose' }] });
  assert.deepEqual(await recallStrategy(hollow.proxyFetch, 'add a retry to the uploader'), { ids: [], text: '' });
});

test('an asset with no strategy gives way to the next one in the same answer', async () => {
  const { proxyFetch, calls } = stubProxy({
    assets: [
      { asset_id: 'sha256:prose', asset_type: 'Gene', similarity: 0.98, summary: 'Nothing to reuse here.' },
      { asset_id: 'sha256:usable', asset_type: 'Gene', similarity: 0.71, strategy: ['Use the one that carries steps.', 'Then the next.', 'Then the next.', 'Then the last.'] },
    ],
  });

  const { ids, text } = await recallStrategy(proxyFetch, 'add a retry to the uploader');
  assert.equal(calls.length, 1, 'the fallback costs no second round trip');
  assert.deepEqual(ids, ['sha256:usable']);
  assert.match(text, /^1\. Use the one that carries steps\.$/m);
  assert.doesNotMatch(text, /sha256:prose/);
});

test('a topical but low-similarity asset is dropped', async () => {
  const { proxyFetch } = stubProxy({
    assets: [{ asset_id: 'sha256:loose', similarity: 0.22, short_title: '小红书内容创作工作流', strategy: ['先定选题。', '再写标题。', '再写正文。', '最后配图。'] }],
  });

  assert.deepEqual(await recallStrategy(proxyFetch, 'add a retry to the uploader'), { ids: [], text: '' });
});

test('the similarity line is configurable, and a Proxy that omits the score still answers', async () => {
  const scored = stubProxy({ assets: [{ ...ASSET, similarity: 0.35 }] });
  const { ids } = await recallStrategy(scored.proxyFetch, 'add a retry to the uploader', { minSimilarity: 0.3 });
  assert.deepEqual(ids, ['sha256:abc']);

  const unscored = stubProxy({ assets: [ASSET] });
  assert.deepEqual((await recallStrategy(unscored.proxyFetch, 'add a retry to the uploader')).ids, ['sha256:abc']);
});

test('the best-scoring asset wins, whatever order the Hub listed them in', async () => {
  const { proxyFetch } = stubProxy({
    assets: [
      { asset_id: 'sha256:middling', asset_type: 'Gene', similarity: 0.62, strategy: ['Middling.', 'Middling.', 'Middling.', 'Middling.'] },
      { asset_id: 'sha256:closest', asset_type: 'Gene', similarity: 0.94, strategy: ['Take the closest match.', 'Then the next.', 'Then the next.', 'Then the last.'] },
      { asset_id: 'sha256:weak', asset_type: 'Gene', similarity: 0.51, strategy: ['Weak.', 'Weak.', 'Weak.', 'Weak.'] },
    ],
  });

  const { ids, text } = await recallStrategy(proxyFetch, 'add a retry to the uploader');
  assert.deepEqual(ids, ['sha256:closest']);
  assert.match(text, /^1\. Take the closest match\.$/m);
});

test('an unscored asset is still usable, but never outranks a scored one', async () => {
  const { proxyFetch } = stubProxy({
    assets: [
      { asset_id: 'sha256:unscored', asset_type: 'Gene', strategy: ['Unmeasured.', 'Unmeasured.', 'Unmeasured.', 'Unmeasured.'] },
      { asset_id: 'sha256:scored', asset_type: 'Gene', similarity: 0.55, strategy: ['Prefer the measured match.', 'Then the next.', 'Then the next.', 'Then the last.'] },
    ],
  });

  assert.deepEqual((await recallStrategy(proxyFetch, 'add a retry to the uploader')).ids, ['sha256:scored']);
});

test('a named gene is announced by its name, and its hash only where it gets used', async () => {
  const { proxyFetch } = stubProxy({
    assets: [{
      asset_id: 'sha256:named', asset_type: 'Gene', similarity: 0.9,
      short_title: 'Chinese Social Media Writing Template',
      nl_summary: 'A long explanation that has no business being in front of the model on every turn.'.repeat(3),
      summary: 'Also long, also not the header.',
      strategy: ['Draft it.', 'Edit it.', 'Check it.', 'Ship it.'],
    }],
  });

  const { text } = await recallStrategy(proxyFetch, 'add a retry to the uploader');

  assert.match(text, /^\[Evolution Memory\] Chinese Social Media Writing Template \(EvoMap network\):$/m);
  assert.doesNotMatch(text.split('\n')[0], /sha256:/, 'the hash is not what the header is for');
  assert.match(text, /Evolver reports how the reuse of sha256:named went when this turn ends\./);
  assert.doesNotMatch(text, /no business being in front of the model|Also long/);
});

test('an asset with neither a name nor a description falls back to its type', async () => {
  const { proxyFetch } = stubProxy({
    assets: [{ asset_id: 'sha256:plain', asset_type: 'Capsule', similarity: 0.9, strategy: ['Do it.', 'Do it.', 'Do it.', 'Do it.'] }],
  });

  const { text } = await recallStrategy(proxyFetch, 'add a retry to the uploader');
  assert.match(text, /^\[Evolution Memory\] Capsule \(EvoMap network\):$/m);
});

test('a one-word title is a truncation, not a name, so the summary stands in', async () => {
  const { proxyFetch } = stubProxy({
    assets: [{
      asset_id: 'sha256:fragment', asset_type: 'Gene', similarity: 0.9,
      short_title: 'Object',
      nl_summary: 'A generic object pool for reusing expensive resources such as database connections, so they are not rebuilt per request.',
      strategy: ['Initialize the pool.', 'Size it.', 'Lend from it.', 'Return to it.'],
    }],
  });

  const { text } = await recallStrategy(proxyFetch, 'reuse database connections');
  const header = text.split('\n')[0];

  assert.doesNotMatch(header, /\] Object \(/, 'Object is what got truncated, not what the gene is');
  assert.match(header, /A generic object pool for reusing expensive resources/);
  assert.ok(header.length <= 120, 'the stand-in is a name-length excerpt, not the whole summary');
});

test('a short CJK title is a name, and is not mistaken for a fragment', async () => {
  const { proxyFetch } = stubProxy({
    assets: [{
      asset_id: 'sha256:cjk', asset_type: 'Gene', similarity: 0.9,
      short_title: '智能缓存优化',
      nl_summary: '这个基因用于优化缓存命中率。',
      strategy: ['预热缓存。', '设置淘汰策略。', '监控命中率。', '定期复查。'],
    }],
  });

  const { text } = await recallStrategy(proxyFetch, '这个服务的缓存命中率太低了，帮我优化一下');
  assert.match(text.split('\n')[0], /^\[Evolution Memory\] 智能缓存优化 \(EvoMap network\):$/);
});

test('a truncated CJK title gives way to the summary as well', async () => {
  const { proxyFetch } = stubProxy({
    assets: [{
      asset_id: 'sha256:cut', asset_type: 'Gene', similarity: 0.9,
      short_title: '自动化小',
      nl_summary: '这个基因能自动帮你创作小红书笔记并一键发布。',
      signals_match: ['小红书种草笔记'],
      strategy: ['先定选题。', '再写标题。', '再写正文。', '最后配图。'],
    }],
  });

  const { text } = await recallStrategy(proxyFetch, '帮我写一篇小红书的种草笔记');
  assert.match(text.split('\n')[0], /这个基因能自动帮你创作小红书笔记/);
});

test('the Hub\'s own envelope shapes are all read', async () => {
  const nested = stubProxy({ payload: { results: [ASSET] } });
  assert.deepEqual((await recallStrategy(nested.proxyFetch, 'add a retry to the uploader')).ids, ['sha256:abc']);

  const results = stubProxy({ results: [ASSET] });
  assert.deepEqual((await recallStrategy(results.proxyFetch, 'add a retry to the uploader')).ids, ['sha256:abc']);
});

test('a strategy too thin to reuse gives way to one that fits', async () => {
  const fits = ['Read the plan.', 'Apply it.', 'Check it.', 'Record it.'];
  const { proxyFetch, calls } = stubProxy({
    assets: [
      { asset_id: 'sha256:thin', asset_type: 'Gene', similarity: 0.99, strategy: ['Try harder.', 'Ship it.', 'Hope.'] },
      { asset_id: 'sha256:fits', asset_type: 'Gene', similarity: 0.5, strategy: fits },
    ],
  });

  const { ids, text } = await recallStrategy(proxyFetch, 'add a retry to the uploader');
  assert.equal(calls.length, 1, 'the rejection is read off the one answer');
  assert.deepEqual(ids, ['sha256:fits']);
  assert.match(text, /^4\. Record it\.$/m);
  assert.doesNotMatch(text, /Try harder/);
});

test('a long strategy is injected whole, with no upper bound on its steps', async () => {
  const { proxyFetch } = stubProxy({
    assets: [{ asset_id: 'sha256:long', asset_type: 'Capsule', similarity: 0.95, strategy: Array.from({ length: 21 }, (step, index) => `Pipeline step ${index}.`) }],
  });

  const { ids, text } = await recallStrategy(proxyFetch, 'add a retry to the uploader');
  assert.deepEqual(ids, ['sha256:long']);
  assert.match(text, /^21\. Pipeline step 20\.$/m);
});

test('four steps is the least a strategy needs', async () => {
  const four = stubProxy({ assets: [{ asset_id: 'sha256:four', asset_type: 'Gene', strategy: ['a.', 'b.', 'c.', 'd.'] }] });
  assert.deepEqual((await recallStrategy(four.proxyFetch, 'add a retry to the uploader')).ids, ['sha256:four']);
});

test('engine reminders, markup and links are not matched, and a bare reminder recalls nothing', async () => {
  assert.equal(
    promptTextOf('<scheduled-task name="triage">Triage the open Sentry issues</scheduled-task> see https://example.sentry.io/issues/?project=1'),
    'Triage the open Sentry issues see',
  );
  assert.equal(promptTextOf('<system-reminder>\nThe session "Hub" sent a message.\n</system-reminder>'), '');
  assert.equal(promptTextOf('<system-reminder>unterminated reminder text'), '');

  const { proxyFetch, calls } = stubProxy({ assets: [ASSET] });
  assert.deepEqual(await recallStrategy(proxyFetch, promptTextOf('<system-reminder>Linked sessions notice</system-reminder>')), { ids: [], text: '' });
  assert.equal(calls.length, 0);
});

test('a strategy that would inject more than 4000 characters gives way to the next', async () => {
  const long = Array.from({ length: 12 }, (step, index) => `${'x'.repeat(380)} step ${index}.`);
  const { proxyFetch } = stubProxy({
    assets: [
      { asset_id: 'sha256:transcript', asset_type: 'Capsule', similarity: 0.99, strategy: long },
      { asset_id: 'sha256:fits', asset_type: 'Gene', similarity: 0.5, strategy: ['Read it.', 'Apply it.', 'Check it.', 'Record it.'] },
    ],
  });
  assert.deepEqual((await recallStrategy(proxyFetch, 'add a retry to the uploader')).ids, ['sha256:fits']);
});

test('keys and tokens are stripped from the prompt before it leaves for recall', async () => {
  const { proxyFetch, calls, searches } = stubProxy({ assets: [] });
  const prompt = promptTextOf('upload retry fails with ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuvwxyz0123');
  await recallStrategy(proxyFetch, prompt);
  for (const sent of [calls[0].body.text, searches[0].q]) {
    assert.doesNotMatch(sent, /sk-ant|ghp_/);
    assert.match(sent, /upload retry fails with/);
  }
});

test('what the Hub answers is injected, in any language, without sharing a word with the prompt', async () => {
  const prompt = '帮我规划一下新开的小红书账号，前三个月该怎么做内容';
  const chinese = { asset_id: 'sha256:zh', short_title: '为小红书账号建立从账号分类到赛道定位的运营流程', strategy: ['先给账号分类。', '再定 3+1 赛道。', '按赛道排内容日历。', '每周复盘数据。'] };
  const english = { asset_id: 'sha256:en', short_title: 'Guide Xiaohongshu operations from account setup to growth', strategy: ['Pick the niche.', 'Plan a weekly calendar.', 'Post at peak hours.', 'Review the metrics weekly.'] };

  assert.deepEqual((await recallStrategy(stubProxy({ assets: [chinese] }).proxyFetch, prompt)).ids, ['sha256:zh']);
  assert.deepEqual((await recallStrategy(stubProxy({ assets: [english] }).proxyFetch, prompt)).ids, ['sha256:en']);
});
