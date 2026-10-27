import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import profile from '../../../hosts/claude-code/profile.js';
import { endedTurnSummaryOf as summaryLineOf } from '../../../lib/turn-summary.js';

const { captured, typed } = JSON.parse(readFileSync(new URL('../../fixtures/claude-code/events.json', import.meta.url), 'utf8'));
const SESSION = { session_id: captured.session.id, cwd: captured.session.cwd };
const resultOf = (ran) => ({ text: ran.text ?? '', isError: ran.isError === true, denied: ran.deny !== undefined });
const context = (hostEvent) => ({ hostEvent });

test('a submitted prompt opens a turn, named by its turn id, in the session and folder of the event', () => {
  const payload = { ...SESSION, turn_id: captured.turnStart.turnId, text: captured.turnStart.text, origin: captured.promptSubmit.origin };
  assert.equal(profile.payload.sessionId(payload), captured.session.id);
  assert.equal(profile.payload.turnId(payload), captured.turnStart.turnId);
  assert.equal(profile.payload.prompt(payload), captured.promptSubmit.text);
  assert.equal(profile.payload.projectDir(payload), '/proj');
  assert.equal(profile.payload.isIgnored(payload, context('turn.start')), false);
});

test('a turn nobody typed is recalled for nothing but counts; a subagent\'s turn end is not the session\'s', () => {
  const turn = { ...SESSION, turn_id: 't', text: 'x' };
  assert.equal(profile.payload.isIgnored({ ...turn, origin: { kind: 'task-notification' } }, context('turn.start')), false);
  assert.equal(profile.payload.prompt({ ...turn, origin: { kind: 'task-notification' } }), '');
  assert.equal(profile.payload.prompt({ ...turn, origin: { kind: 'composer' } }), 'x');
  assert.equal(profile.payload.isIgnored({ ...turn, agent_id: 'agent_7' }, context('turn.complete')), true);
  assert.equal(profile.payload.isIgnored({ ...SESSION, call: typed.subagentBash, result: resultOf(typed.bashPassed) }, context('tool.call')), false);
});

test('a turn ends the way Claude Code says it did, and an end it does not name is an error', () => {
  const end = { ...SESSION, turn_id: captured.turnComplete.turnId, reason: captured.turnComplete.reason, answer: captured.turnComplete.answer };
  assert.equal(profile.turnEnd.reason(end), 'error');
  for (const reason of ['answer', 'aborted', 'refusal']) assert.equal(profile.turnEnd.reason({ reason }), reason);
  assert.equal(profile.turnEnd.reason({ reason: 'something-new' }), 'error');
  assert.equal(profile.turnEnd.answer({ answer: 'Done.' }), 'Done.');
});

test('a shell run is a check with its verdict; a background run has none yet; a denied call never ran', () => {
  const note = (call, ran) => profile.evidence.toolNote({ ...SESSION, call, result: resultOf(ran) }, context('tool.call'));
  assert.deepEqual(note(typed.bash, typed.bashPassed), { kind: 'shell', command: 'node --test', exit: 0, output: '# pass 1\n# fail 0', label: 'Run the tests' });
  assert.deepEqual(note(typed.bash, typed.bashFailed), { kind: 'shell', command: 'node --test', exit: 1, output: '# pass 0\n# fail 1', label: 'Run the tests' });
  assert.equal(note({ tool: 'Bash', command: "python3 - <<'EOF'\nprint('npm test')\nEOF" }, typed.bashPassed).label, "python3 - <<'EOF'");
  assert.deepEqual(note(typed.bashInBackground, typed.bashPassed), { kind: 'tool', command: 'npm test', paths: [] });
  assert.equal(note(typed.bash, typed.denied), null);
});

test('an edit names the file it wrote, hashed before it runs; a read is only a path', () => {
  const note = (call, ran) => profile.evidence.toolNote({ ...SESSION, call, result: resultOf(ran) }, context('tool.call'));
  assert.deepEqual(note(typed.edit, typed.editDone), { kind: 'edit', paths: ['/proj/add.js'], lines: 2 });
  assert.deepEqual(note(typed.write, typed.editDone), { kind: 'edit', paths: ['/proj/add.test.js'], lines: 2 });
  assert.equal(note(typed.edit, { isError: true, text: 'old_string not found' }), null);
  assert.deepEqual(note(typed.read, { text: '# readme' }), { kind: 'tool', paths: ['/proj/README.md'] });
  assert.deepEqual(profile.evidence.editedFiles({ ...SESSION, call: typed.edit }, context('tool.call.before')), ['/proj/add.js']);
  assert.deepEqual(profile.evidence.editedFiles({ ...SESSION, call: typed.bash }, context('tool.call.before')), []);
});

test('answers: a strategy is appended, a notice toasted, a command shown with its strategy as context, evolve submitted', () => {
  assert.deepEqual(profile.reply.context('[Evolution Memory] x'), { append: '[Evolution Memory] x' });
  assert.deepEqual(profile.reply.context(''), {});
  assert.deepEqual(profile.reply.notice('Evolver started.'), { toast: 'Evolver started.' });
  assert.deepEqual(profile.reply.command({ ok: true, text: 'found', strategy: { text: '[Evolution Memory] y' } }), { text: 'found', context: ['[Evolution Memory] y'] });
  assert.deepEqual(profile.reply.command({ ok: false, text: 'Proxy down' }), { text: 'Proxy down', exitCode: 1 });
  assert.deepEqual(profile.reply.command({ ok: true, text: 'Reflect.', forAgent: true }), { submit: 'Reflect.' });
  assert.equal(profile.commands.parse({ command: 'evolver-drafts', args: ' publish 1 ' }, 'command.run').args, 'publish 1');
  assert.equal(profile.commands.parse({ text: '/evolver-status' }, 'turn.start'), null);
  assert.equal(profile.commands.answerReachesModel, true);
});

test('a turn that reused a strategy ends with the one-line summary; any other turn with none', () => {
  const strategies = ['[Evolution Memory] Fix flaky Redis connection retries (EvoMap network):\n1. a.'];
  const record = { checks: [{ command: 'npm test', failed: false, label: 'Run the tests' }], changedLines: 12 };
  const line = summaryLineOf({ strategies, record }, { reason: 'answer', usage: { input_tokens: 1_000, output_tokens: 500 } });
  assert.match(line, /^✓ Goal reached \(last check passed: Run the tests\) · reused EvoMap strategy "Fix flaky Redis connection retries"/);
  assert.equal(summaryLineOf({ strategies, record: { checks: [] } }, { reason: 'answer' }), '✓ Goal reached · reused EvoMap strategy "Fix flaky Redis connection retries"');
  assert.deepEqual(profile.reply.turnEnd({ strategies: [], record: { checks: [] } }, 'turn.complete', {}), {});
});

test('the relay runs under Claude Code: its owner is the process that started it, its model the session\'s', () => {
  assert.equal(profile.channel, 'relay');
  assert.equal(profile.owner, 'parent');
  assert.deepEqual(profile.budgets, { prompt: 0 }, 'turn.start holds no model call, so every recall is a late one');
  assert.deepEqual(profile.model, { kind: 'sdk' });
  assert.equal(profile.payload.model({ model: captured.session.model }), 'claude-haiku-5-5');
});
