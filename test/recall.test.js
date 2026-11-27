import assert from 'node:assert/strict';
import { test } from 'node:test';

import { recallStrategy, promptTextOf, recentTurnsOf, taskTextOf } from '../lib/recall.js';

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
  assert.equal(promptTextOf('x'.repeat(2500)).length, 2000);
  assert.equal(promptTextOf(undefined), '');
});

test('the recall text and the task context reach past a long shared preamble', () => {
  const prompt = `${'shared preamble '.repeat(60)}the task itself ${'detail '.repeat(800)}`;
  assert.ok(promptTextOf(prompt).includes('the task itself'));
  assert.ok(taskTextOf(prompt).startsWith(promptTextOf(prompt)));
  assert.equal(taskTextOf(prompt).length, 4000);
});

test('the task context leaves for the Proxy whole when it fits 4096 bytes', async () => {
  const { proxyFetch, calls, searches } = stubProxy({ assets: [] });
  const task = taskTextOf('a'.repeat(5000));
  await recallStrategy(proxyFetch, 'upload retry fails', { context: { task, trigger: 'turn_start' } });
  assert.equal(calls[0].body.context.task, task);
  assert.equal(searches[0].context.task, task);
});

test('quoted JSON credentials are redacted from the recall query and task context', async () => {
  const { proxyFetch, calls, searches } = stubProxy({ assets: [] });
  const prompt = 'Retry the uploader with this config: {"token":"fixtureCredential123456","accessToken":"fixtureAccess123456","mode":"retry"}';
  await recallStrategy(proxyFetch, promptTextOf(prompt), { context: { task: taskTextOf(prompt), trigger: 'turn_start' } });
  assert.equal(calls.length, 1);
  assert.equal(searches.length, 1);
  for (const body of [calls[0].body, searches[0]]) {
    const sent = JSON.stringify(body);
    assert.doesNotMatch(sent, /fixture(?:Credential|Access)123456/);
    assert.match(sent, /retry/i);
  }
});

test('a CJK task of 4000 characters leaves for the Proxy whole within its 16 KiB', async () => {
  const { proxyFetch, calls, searches } = stubProxy({ assets: [] });
  const task = taskTextOf('上传失败后重试'.repeat(600));
  await recallStrategy(proxyFetch, 'upload retry fails', { context: { task, trigger: 'turn_start' } });
  assert.equal(task.length, 4000);
  for (const sent of [calls[0].body.context, searches[0].context]) assert.equal(sent.task, task);
});

test('recent turns over the Proxy limit go oldest first, a prompt with its answer, and the task stays whole', async () => {
  const { proxyFetch, calls, searches } = stubProxy({ assets: [] });
  const task = taskTextOf('上传失败后重试'.repeat(600));
  const turns = ['一', '二', '三'].flatMap((mark) => [{ role: 'user', text: mark.repeat(500) }, { role: 'assistant', text: mark.repeat(800) }]);
  await recallStrategy(proxyFetch, 'upload retry fails', { context: { task, trigger: 'turn_start', recent_turns: turns, title: '上传重试' } });
  for (const sent of [calls[0].body.context, searches[0].context]) {
    assert.ok(Buffer.byteLength(JSON.stringify(sent)) <= 16_384);
    assert.equal(sent.task, task);
    assert.equal(sent.title, '上传重试');
    assert.ok(sent.recent_turns.length > 0 && sent.recent_turns.length < turns.length);
    assert.equal(sent.recent_turns[0].role, 'user', 'no answer is kept without its prompt');
    assert.deepEqual(sent.recent_turns, turns.slice(-sent.recent_turns.length), 'the newest turns are the ones kept');
  }
});

test('a task context over the Proxy limit is cut to fit, never dropped', async () => {
  const { proxyFetch, calls, searches } = stubProxy({ assets: [] });
  const task = taskTextOf('🔁'.repeat(4000));
  const context = { task, trigger: 'check_failed', language: Array.from({ length: 40 }, (_, index) => `Language${index}`) };
  await recallStrategy(proxyFetch, 'upload retry fails', { context });
  for (const sent of [calls[0].body.context, searches[0].context]) {
    assert.ok(Buffer.byteLength(JSON.stringify(sent)) <= 16_384);
    assert.ok(sent.task.length > 1000);
    assert.ok(task.startsWith(sent.task));
    assert.doesNotMatch(sent.task, /\uFFFD/u);
    assert.deepEqual(sent.language, context.language);
  }
});

test('recent turns are each earlier prompt then its answer, oldest first, cleaned like a prompt', () => {
  assert.deepEqual(recentTurnsOf([]), []);
  assert.deepEqual(recentTurnsOf(undefined), []);
  assert.deepEqual(recentTurnsOf([{ prompt: 'first', answer: '  done, 114 assets  ' }, { prompt: 'second', answer: '' }]), [
    { role: 'user', text: 'first' }, { role: 'assistant', text: 'done, 114 assets' }, { role: 'user', text: 'second' },
  ]);
  const [prompt, answer] = recentTurnsOf([{ prompt: 'x'.repeat(900), answer: 'y'.repeat(1500) }]);
  assert.equal(prompt.text.length, 500);
  assert.equal(answer.text.length, 800, 'an answer keeps its opening');
  const long = ['a', 'b', 'c', 'd'].map((mark) => ({ prompt: mark.repeat(500), answer: mark.repeat(800) }));
  assert.deepEqual(recentTurnsOf(long).map(({ text }) => text[0]), ['b', 'b', 'c', 'c', 'd', 'd'], 'at most 4000 characters, whole turns, the newest kept');
  assert.doesNotMatch(JSON.stringify(recentTurnsOf([{ prompt: 'retry it', answer: 'used {"token":"fixtureCredential123456"} to retry' }])), /fixtureCredential123456/);
});

test('one call recalls by text and injects that asset\'s strategy alone', async () => {
  const { proxyFetch, calls } = stubProxy({ assets: [ASSET] });
  const { ids, text } = await recallStrategy(proxyFetch, 'add a retry to the uploader');

  assert.deepEqual(calls.map((call) => call.path), ['/asset/fetch']);
  assert.deepEqual(calls[0].body, { text: 'add a retry to the uploader', signals: ['retry', 'uploader'] }, 'no limit: the Hub default applies');
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

test('a link ends where the Chinese text written right after it begins', () => {
  assert.equal(
    promptTextOf('我们新官网(https://canary.evomap.work/zh)本周上线，帮我做一条 20 秒的展示视频'),
    '我们新官网( 本周上线，帮我做一条 20 秒的展示视频',
  );
  assert.equal(promptTextOf('看 https://example.com/a?b=1，帮我总结这篇文章'), '看 ，帮我总结这篇文章');
  assert.equal(promptTextOf('参考 www.example.com/page这个页面的布局'), '参考 这个页面的布局');
});

test('a link keeps a non-ASCII host or path segment that URL structure follows, so its path and query never reach the Hub', () => {
  assert.equal(promptTextOf('分析 https://example.com/患者张三/病例?access_code=ABC123 并给建议'), '分析 并给建议');
  assert.equal(promptTextOf('阅读 https://例子.测试/docs 并总结'), '阅读 并总结');
  assert.equal(promptTextOf('访问 https://例子.测试'), '访问');
  assert.equal(promptTextOf('搜 https://example.com/search?q=患者张三 看结果'), '搜 看结果');
  assert.equal(promptTextOf('跳到 https://example.com/doc#章节名称，再总结'), '跳到 ，再总结');
  assert.equal(promptTextOf('看 https://example.com/a?b=1帮我总结'), '看 帮我总结');
  assert.equal(promptTextOf('参考 https://sub.例子.测试，然后总结'), '参考 ，然后总结');
  assert.equal(promptTextOf('打开 www.例子.测试 看看'), '打开 看看');
  assert.equal(promptTextOf('跑 http://localhost:3000/api 看看'), '跑 看看');
  assert.equal(promptTextOf('打开 https://例子.测试/文档.html 看看'), '打开 看看');
  assert.equal(promptTextOf('照着这个视频https://v.douyin.com/abc123/复刻一条我们瑜伽App的版本'), '照着这个视频 复刻一条我们瑜伽App的版本');
  assert.equal(promptTextOf('看下https://evomap.ai这个网站'), '看下 这个网站');
  assert.equal(promptTextOf('阅读 https://zh.wikipedia.org/wiki/中文'), '阅读 中文', 'a last segment with nothing after it reads as the sentence');
});

test('a long non-ASCII run after a link is cleaned in linear time', () => {
  const started = performance.now();
  promptTextOf(`https://a.com/${'中'.repeat(200_000)}`);
  promptTextOf(`https://${'中.'.repeat(50_000)}`);
  assert.ok(performance.now() - started < 1_000);
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

test('a strategy longer than its budget keeps its opening and safety lines and names what it left out', async () => {
  const long = [...Array.from({ length: 12 }, (step, index) => `${'x'.repeat(380)} step ${index}.`), 'Safety boundary: never touch prod.'];
  const { proxyFetch } = stubProxy({ assets: [{ asset_id: 'sha256:long', asset_type: 'Gene', similarity: 0.99, strategy: long }] });
  const match = await recallStrategy(proxyFetch, 'add a retry to the uploader');
  assert.deepEqual(match.ids, ['sha256:long']);
  assert.match(match.text, /^\[Evolution Memory\] .*\n1\. x{380} step 0\.\n/);
  assert.match(match.text, /\. Safety boundary: never touch prod\.\n\(\d+ more lines of sha256:long left out for length\.\)\n/);
  assert.ok(!match.text.includes('step 11.'));
});

test('a compiled Gene over its budget keeps its first step and failure line, losing its exact contract first, then its do-not-use line', async () => {
  const filler = (index) => `${'y'.repeat(300)} step ${index}.`;
  const tail = [
    'If npm test fails with ECONNRESET: raise the client retry cap.',
    `Do not use when: ${'the Redis URL is wrong, not the connection. '.repeat(10)}`,
    `Exact command (applies when the suite runs): ${'z'.repeat(300)}`,
  ];
  const rows = [[10, { doNotUse: true, contract: false }], [11, { doNotUse: false, contract: false }]];
  for (const [steps, expected] of rows) {
    const strategy = [...Array.from({ length: steps }, (_, index) => filler(index)), ...tail];
    const { text } = await recallStrategy(stubProxy({ assets: [{ asset_id: 'sha256:ir', asset_type: 'Gene', similarity: 0.99, strategy }] }).proxyFetch, 'add a retry to the uploader');
    assert.match(text, /\n1\. y+ step 0\.\n[\s\S]*\. If npm test fails with ECONNRESET: raise the client retry cap\.\n/, `${steps} steps`);
    assert.deepEqual({ doNotUse: /Do not use when/.test(text), contract: /Exact command/.test(text) }, expected, `${steps} steps`);
  }
});

test('a line is capped by tokens, so a Chinese line keeps as much meaning as an English one', async () => {
  const chinese = '紫'.repeat(150);
  const { proxyFetch } = stubProxy({ assets: [{ asset_id: 'sha256:zh', asset_type: 'Gene', strategy: [chinese, '读', '改', '验'] }] });
  const match = await recallStrategy(proxyFetch, '帮我排一个紫微斗数命盘');
  assert.match(match.text, new RegExp(`\\n1\\. ${'紫'.repeat(100)}\\n`));
});

test('keys and tokens are stripped from the prompt before it leaves for recall', async () => {
  const { proxyFetch, calls, searches } = stubProxy({ assets: [] });
  const prompt = promptTextOf('upload retry fails with ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuvwxyz0123');
  await recallStrategy(proxyFetch, prompt, { context: { task: prompt, trigger: 'turn_start' } });
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
