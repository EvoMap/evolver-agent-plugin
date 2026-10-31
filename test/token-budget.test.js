import assert from 'node:assert/strict';
import { test } from 'node:test';

import { headOf, linesWithin, sharesOf, tokensOf } from '../lib/token-budget.js';

test('a Han character costs a token, Latin text a token per four characters', () => {
  assert.equal(tokensOf('紫微斗数'), 4);
  assert.equal(tokensOf('abcdefgh'), 2);
  assert.equal(tokensOf('排盘 iztro'), 2 + Math.ceil(6 / 4));
});

test('the head of a text stops at the budget, never mid code point', () => {
  assert.equal(headOf('紫微斗数排盘', 3), '紫微斗');
  assert.equal(headOf('abcdefgh', 1), 'abcd');
  assert.equal(headOf('a😀b', 1), 'a😀b');
});

test('an item needing less than an even share keeps all of it, and the rest share what it leaves', () => {
  assert.deepEqual(sharesOf([10, 100, 100], 120), [10, 55, 55]);
  assert.deepEqual(sharesOf([10, 20], 100), [10, 20]);
});

test('lines kept within a budget favour the opening and safety lines, in their own order', () => {
  const lines = ['open the file', 'a'.repeat(200), 'b'.repeat(200), 'Safety boundary: read only'];
  assert.deepEqual(linesWithin(lines, 64), ['open the file', 'a'.repeat(200), 'Safety boundary: read only']);
  assert.deepEqual(linesWithin(lines, 15), ['open the file', 'Safety boundary: read only']);
  assert.deepEqual(linesWithin(lines, 4), [], 'a safety line alone, without the opening it guards, is not kept');
});
