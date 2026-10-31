import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MIN_RELEVANCE, relevanceOf, sharedTerms } from '../lib/relevance.js';

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
