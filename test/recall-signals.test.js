import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_RECALL_SIGNALS, recallSignalsOf } from '../lib/recall-signals.js';

test('error names lead, then the most repeated task terms', () => {
  const text = 'Fix TypeError in the React component; npm test fails with ENOENT. The react hook runs twice in react strict mode.';
  const signals = recallSignalsOf(text);
  assert.deepEqual(signals.slice(0, 3), ['TypeError', 'ENOENT', 'react']);
});

test('preamble words and short words never become signals', () => {
  const signals = recallSignalsOf('You are an agent. Your task is to help the user with the airline reservation and the airline policy.');
  assert.deepEqual(signals, ['airline', 'reservation', 'policy']);
});

test('at most the Hub limit, each term once regardless of case', () => {
  const text = Array.from({ length: 20 }, (_, i) => `term${String.fromCharCode(97 + i)}word`).join(' ') + ' Termaword TERMAWORD';
  const signals = recallSignalsOf(text);
  assert.equal(signals.length, MAX_RECALL_SIGNALS);
  assert.equal(signals.filter((s) => s.toLowerCase() === 'termaword').length, 1);
});

test('no Latin terms or no text sends no signals', () => {
  assert.deepEqual(recallSignalsOf('修复内存泄漏'), []);
  assert.deepEqual(recallSignalsOf(undefined), []);
});
