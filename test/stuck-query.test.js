import assert from 'node:assert/strict';
import { test } from 'node:test';

import { identifiersAddedBy, languagesOf, stuckQueryOf } from '../lib/stuck-query.js';

const GO_OUTPUT = [
  '\x1b[31m--- FAIL: TestScanFolder (0.01s)\x1b[0m',
  '    /home/runner/work/navidrome/scanner/walk_dir_tree_test.go:42: expected 3 dirs, got 2',
  'FAIL\tgithub.com/navidrome/navidrome/scanner\t0.123s',
  'ok  \tgithub.com/navidrome/navidrome/model\t0.010s',
].join('\n');

test('a failed check becomes changed identifiers, error lines, failing tests and file names', () => {
  const query = stuckQueryOf({
    output: GO_OUTPUT,
    paths: ['/repo/scanner/walk_dir_tree.go', '/repo/scanner/walk_dir_tree_test.go'],
    identifiers: ['isDirIgnored', 'ignoredFile', 'isDirIgnored'],
  });
  assert.equal(query, [
    'changed: isDirIgnored, ignoredFile',
    '--- FAIL: TestScanFolder (0.01s); walk_dir_tree_test.go:42: expected 3 dirs, got 2; FAIL\tgithub.com/navidrome/navidrome/scanner\t0.123s',
    'failing: TestScanFolder, github.com/navidrome/navidrome/scanner',
    'files: walk_dir_tree.go, walk_dir_tree_test.go',
  ].join(' | '));
});

test('output naming no error yields no query', () => {
  assert.equal(stuckQueryOf({ output: 'Killed', paths: ['/a/b.py'] }), '');
  assert.equal(stuckQueryOf({ output: '' }), '');
});

test('secrets in the output never reach the query, and the query is capped', () => {
  const output = `AssertionError: token=${'s'.repeat(30)} rejected\n${Array.from({ length: 40 }, (_, i) => `Error: case ${i} ${'x'.repeat(100)}`).join('\n')}`;
  const query = stuckQueryOf({ output });
  assert.doesNotMatch(query, /s{30}/);
  assert.ok(query.length <= 512);
});

test('languages come from the touched files; identifiers from what an edit added, keywords left out', () => {
  assert.deepEqual(languagesOf(['/a/x.py', '/a/y.tsx', '/a/z.ts', '/a/README.md']), ['Python', 'TypeScript']);
  assert.deepEqual(identifiersAddedBy('const retries = 3', 'const retries = maxRetries(budget) ?? null'), ['maxRetries', 'budget']);
  assert.deepEqual(identifiersAddedBy('', 'def parse_hsv(value): pass'), ['parse_hsv', 'value']);
});
