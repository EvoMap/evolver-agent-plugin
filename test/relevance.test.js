import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { recallStrategy } from '../lib/recall.js';
import { MIN_RELEVANCE, relevanceOf, sharedTerms } from '../lib/relevance.js';

// Recalled from a live local Proxy (which reports no similarity) and trimmed to
// the fields relevance reads; the Hub's order is kept.
const LIVE = JSON.parse(readFileSync(new URL('./fixtures/recall-live.json', import.meta.url), 'utf8'));

async function recalled(prompt) {
  const proxyFetch = async () => ({ ok: true, data: { assets: LIVE[prompt], recalled_by: 'text' } });
  return recallStrategy(proxyFetch, prompt);
}

test('a conversational follow-up injects nothing, whatever the Hub ranked first', async () => {
  assert.deepEqual(await recalled('还有多少没有对齐？'), { ids: [], text: '' });
  assert.deepEqual(await recalled('先调阈值把'), { ids: [], text: '' });
});

test('a real task still injects the strategy that matches it', async () => {
  assert.match((await recalled('修复登录接口偶发 500 的问题，日志里是 redis 连接超时')).text, /Redis/);
  assert.match((await recalled('add a retry with exponential backoff to the upload client')).text, /backoff/i);
  assert.match((await recalled('把这个 React 组件的列表渲染改成虚拟滚动，现在 5000 条数据很卡')).text, /virtual scrolling/i);
});

test('generic task words and function words are not evidence', () => {
  const asset = { summary: '修复问题，优化实现，确保支持' };
  assert.deepEqual(sharedTerms('修复这个问题并优化实现', asset), []);
  assert.deepEqual(sharedTerms('add the fix for this', { summary: 'Add a fix for the thing' }), []);
});

test('a Latin term matches its own inflections', () => {
  assert.deepEqual(sharedTerms('retry the uploader', { summary: 'Retries for upload' }).sort(), ['retry', 'upload']);
  assert.deepEqual(sharedTerms('the caches for queues', { summary: 'Caching a queue' }).sort(), ['cach', 'queue']);
  assert.deepEqual(sharedTerms('redis status class', { summary: 'Redis status class' }).sort(), ['class', 'redis', 'status']);
  assert.deepEqual(sharedTerms('apis', { summary: 'api' }), [], 'an -is plural is kept whole, the price of keeping redis and analysis whole');
});

test('two Han bigrams alone are not enough: a question about a notice is not a prompt-injection task', async () => {
  const prompt = '这个提示语还没改过来呀，这个事哪里注入的，不是插件本身吗？';
  const security = {
    asset_id: 'sha256:7fa5119b',
    short_title: 'Agent安全测试之提示词注入识别与缓解：通过输入检测+输出过滤+防御性提示保障安全',
    strategy: ['注入检测', '输出过滤', '防御性提示', '红队测试', '多层验证', '安全日志'],
  };
  assert.deepEqual(sharedTerms(prompt, security).sort(), ['提示', '注入'].sort());
  assert.equal(relevanceOf(sharedTerms(prompt, security)), 1);
  const proxyFetch = async () => ({ ok: true, data: { assets: [security] } });
  assert.deepEqual(await recallStrategy(proxyFetch, prompt), { ids: [], text: '' });
});

test('a Latin word weighs one, a Han bigram half, and 2 is the bar', () => {
  assert.equal(MIN_RELEVANCE, 2);
  assert.ok(relevanceOf(['redis', '连接', '超时']) >= MIN_RELEVANCE);
  assert.ok(relevanceOf(['缓存', '命中', '中率']) < MIN_RELEVANCE, 'three bigrams alone were off-topic in every live recall');
  assert.ok(relevanceOf(['提示', '注入']) < MIN_RELEVANCE);
});

test('the host\'s own name is not evidence: a toast question is not a Windows toast installer', () => {
  const installer = { short_title: 'Install and configure Agent Toast on Windows so Claude Code hook events notify' };
  assert.deepEqual(sharedTerms('先试一下 toast 在桌面端能不能显示 Claude Code', installer), ['toast']);
});
