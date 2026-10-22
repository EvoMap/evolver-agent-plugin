import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkCommandOf, editedContent, editedPath } from '../lib/claude-code/tool-calls.js';

test('edited content is read from every Claude Code edit tool shape', () => {
  assert.equal(editedContent({ file_path: 'a.js', content: 'whole file' }), 'whole file');
  assert.equal(editedContent({ file_path: 'a.js', old_string: 'x', new_string: 'y' }), 'y');
  assert.equal(editedContent({ file_path: 'a.js', edits: [{ new_string: 'one' }, { new_string: 'two' }] }), 'one\ntwo');
  assert.equal(editedContent({ notebook_path: 'n.ipynb', new_source: 'cell' }), 'cell');
  assert.equal(editedPath({ notebook_path: 'n.ipynb' }), 'n.ipynb');
});

test('a check run through Bash or PowerShell counts, a background one or another tool does not', () => {
  assert.equal(checkCommandOf({ tool: 'Bash', command: 'npm test' }), 'npm test');
  assert.equal(checkCommandOf({ tool: 'PowerShell', command: 'npm run build' }), 'npm run build');
  assert.equal(checkCommandOf({ tool: 'Bash', command: 'npm test', run_in_background: true }), null);
  assert.equal(checkCommandOf({ tool: 'Bash', command: 'git status' }), null);
  assert.equal(checkCommandOf({ tool: 'Read', command: 'npm test' }), null);
});
