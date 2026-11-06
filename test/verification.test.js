import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isVerificationCommand, verificationFailed, verificationFailureOf } from '../lib/verification.js';

test('test, build, lint and type-check runs are verifications; other commands are not', () => {
  for (const command of ['npm test', 'pnpm run build', 'yarn lint', 'node --test test/*.test.js', 'npx vitest run', 'go test ./...',
    'cargo clippy', 'npx -p typescript tsc -p .', 'make', 'claude plugin validate .', 'cd app && npm run typecheck']) {
    assert.equal(isVerificationCommand(command), true, command);
  }
  for (const command of ['ls -la', 'git status', 'cat package.json', 'npm install', 'echo test']) {
    assert.equal(isVerificationCommand(command), false, command);
  }
});

test('check names in arguments, quoted data and comments are not executions', () => {
  for (const command of [
    'echo "npm test"', 'echo npm test', 'printf "%s\\n" "make"', 'rg pytest README.md',
    'node -e "console.log(\'npm test\')"', 'git status # npm test', '# npm test\npwd',
    'echo "notes; npm test"', "printf 'notes\nnpm test\n'", 'echo `pwd; npm test`',
    'npx echo npm test', 'timeout --signal TERM 60 echo npm test', 'sudo -n echo npm test', 'npm exec echo "npm test"',
    'echo # note; npm test', 'echo bash -c "npm test"', 'bash -c "echo npm test"', 'echo $(printf x; npm test)', 'echo $(echo $(printf x); npm test)',
  ]) {
    assert.equal(isVerificationCommand(command), false, command);
  }
});

test('a hash after an escaped separator stays in the current shell word', () => {
  for (const command of [
    String.raw`echo arg\ #literal && npm test`, 'echo arg\\\t#literal; npm test',
    String.raw`echo arg\\\ #literal; npm test`, String.raw`echo $(echo arg\ #literal) && npm test`,
    String.raw`echo arg\;#literal && npm test`,
  ]) assert.equal(isVerificationCommand(command), true, command);
  for (const command of [
    String.raw`echo arg\\ # comment; npm test`, String.raw`echo arg\  # comment; npm test`,
    'echo "arg " # "$(; npm test\npwd',
  ]) assert.equal(isVerificationCommand(command), false, command);
  assert.equal(isVerificationCommand('echo # "$( ignored\nnpm test'), true);
});

test('command positions in chains, pipelines, environment assignments and npx wrappers still count', () => {
  for (const command of [
    'sleep 2; node --test', 'npm test 2>&1 | tail -5', 'CI=1 npm test', 'env CI=1 npm test',
    'npx --yes vitest run', 'npx --package=typescript tsc -p .', 'npx --package typescript tsc -p .',
    'echo "notes; npm test"\nnode --test', 'curl http://x/#f && npm test', 'git log --format=%h#%s; npm test',
    'cd $(git rev-parse --show-toplevel) && npm test', 'cd $(echo "$(pwd)") && npm test',
    'bash -c "npm test"', "sh -c 'cd app && npm test'", 'timeout 60 npm test', 'timeout --signal=TERM 60 npm test', 'sudo npm test', 'sudo -n npm test', 'time npm test', 'time -p npm test', 'nohup npm test', 'env -i npm test',
    'yarn vitest', 'bunx vitest', 'python -m pytest', 'uv run pytest', 'poetry run pytest',
    '{ npm test; }', 'if true; then npm test; fi', 'C:\\tools\\make.exe',
  ]) {
    assert.equal(isVerificationCommand(command), true, command);
  }
});

test('a known executable reached through a path still verifies, while a path in an argument does not', () => {
  for (const command of [
    './gradlew test', 'gradlew.bat test', 'npm.cmd test', 'C:\\tools\\pnpm.cmd lint', './node_modules/.bin/tsc --noEmit', '/usr/bin/make',
    'cd app && ./gradlew test', 'CI=1 ./node_modules/.bin/tsc --noEmit',
    '/usr/bin/npx --yes ./node_modules/.bin/tsc --noEmit',
  ]) {
    assert.equal(isVerificationCommand(command), true, command);
  }
  for (const command of [
    'echo ./gradlew test', 'cat ./node_modules/.bin/tsc', 'echo /usr/bin/make',
    'echo "notes; ./gradlew test"', '/usr/bin/npx echo ./gradlew test', './scripts/make-not-a-check',
  ]) {
    assert.equal(isVerificationCommand(command), false, command);
  }
});

test('supported wrapper options still leave the actual command in command position', () => {
  for (const command of [
    'sudo -u root npm test', 'sudo --user=root -- npm test', 'env -u CI npm test',
    'env --unset=CI --chdir app npm test', 'timeout -s KILL 60 npm test', 'time -p npm test',
    'exec npm test', '! npm test', 'time ! npm test',
  ]) assert.equal(isVerificationCommand(command), true, command);
  for (const command of [
    'sudo -u root echo npm test', 'sudo -u npm test', 'env -u npm test',
    'env --chdir app echo npm test', 'exec echo npm test', '! echo npm test',
  ]) assert.equal(isVerificationCommand(command), false, command);
});

test('literal shell and package-manager wrappers recognise only the command they execute', () => {
  for (const command of [
    "/bin/bash -c 'npm test'", 'bash -lc "npm test"', "/usr/bin/bash -lc 'cd app && npm test'",
    'corepack pnpm test', 'corepack yarn vitest run', 'command npm test', 'command -p -- npm test',
    'npm exec -- vitest run', 'npm exec --yes --package typescript -- tsc --noEmit',
    'corepack npm exec --package=vitest -- vitest run',
    'pnpm exec vitest run', 'pnpm exec -- vitest run', 'corepack pnpm exec vitest run', 'pnpm -r exec jest', 'pnpm exec --recursive jest',
  ]) assert.equal(isVerificationCommand(command), true, command);
  for (const command of [
    "echo /bin/bash -c 'npm test'", '/bin/bash -c "echo npm test"', 'bash -lc "$CHECK"', "bash -lc\n'npm test'",
    'corepack enable pnpm', 'corepack echo npm test', 'command -v npm test', 'command -V npm test',
    'command -- echo npm test', 'command ! npm test', 'npm exec -- echo "vitest run"', 'npm exec --package=vitest -- echo vitest',
    "npm exec -c 'echo vitest run'",
    'echo pnpm exec vitest run', 'pnpm exec echo vitest run', 'pnpm exec --help vitest',
  ]) assert.equal(isVerificationCommand(command), false, command);
});

test('a literal shell script runs in a chained or wrapped command position', () => {
  for (const command of [
    "cd app && /bin/bash -c 'npm test'",
    'env CI=1 bash -c "npm test"',
    "sudo -u root -- bash -c 'npm test'",
    "cd app && env -i CI=1 sudo -n '/usr/bin/bash' -lc 'npm test'",
  ]) assert.equal(isVerificationCommand(command), true, command);
  for (const command of [
    "cd app && echo bash -c 'npm test'",
    "env CI=1 bash -c 'echo npm test'",
    "sudo -u bash -c 'npm test'",
    'sudo -n bash -c "$CHECK"',
    'cd app && bash -c "$(echo npm test)"',
    "cd app && bash -c 'npm test'$EXTRA",
    "echo $(bash -c 'npm test')",
  ]) assert.equal(isVerificationCommand(command), false, command);
});

test('literal quoted executables count only in command position', () => {
  for (const command of [
    '"./node_modules/.bin/jest"', "'./path with spaces/gradlew' build",
    'sudo -u "build user" "./node_modules/.bin/jest"', '"/usr/bin/env" -u CI "./node_modules/.bin/jest"',
    '"C:\\Program Files\\nodejs\\npm.cmd" test',
  ]) assert.equal(isVerificationCommand(command), true, command);
  for (const command of [
    'echo "./node_modules/.bin/jest"', '"npm test"', '"$runner/jest"',
    '"./node_modules/.bin/jest"-other', '"notes; npm test"',
  ]) assert.equal(isVerificationCommand(command), false, command);
});

test('a non-zero exit fails the verification', () => {
  assert.equal(verificationFailed({ isError: true, text: '' }), true);
});

test('failure output fails it even when the command exited zero', () => {
  assert.equal(verificationFailed({ text: 'AssertionError: expected 1 to equal 2\n1 test failed' }), true);
  assert.equal(verificationFailed({ text: 'TypeError: cannot read properties of undefined' }), true);
});

test('a zero count beside a failure does not hide it', () => {
  assert.equal(verificationFailed({ text: 'Tests: 1 failed, 0 errors' }), true);
  assert.equal(verificationFailed({ text: 'failures: 0, errors: 2 — test failed' }), true);
});

test('a passing summary that counts zero failures passes', () => {
  assert.equal(verificationFailed({ text: 'ℹ tests 78\nℹ pass 78\nℹ fail 0' }), false);
  assert.equal(verificationFailed({ text: 'Tests: 0 failed, 12 passed' }), false);
  assert.equal(verificationFailed({ text: 'failures: 0\nerrors: 0' }), false);
  assert.equal(verificationFailed({ text: '✔ Validation passed' }), false);
});

test('missing exit status is unknown unless a supported summary proves the check passed or failed', () => {
  for (const exit of [undefined, null, '0', NaN]) {
    for (const text of ['', 'boom\n', 'done', 'ok', 'ℹ pass 1']) {
      assert.equal(verificationFailureOf({ exit, text }), null, `${exit}/${text}`);
    }
  }
  assert.equal(verificationFailureOf({ exit: 0, text: '' }), false);
  assert.equal(verificationFailureOf({ exit: 3, text: 'done' }), true);
  assert.equal(verificationFailureOf({ text: 'TAP version 13\n# pass 1\n# fail 0\n' }), false);
  assert.equal(verificationFailureOf({ text: 'ℹ pass 3\nℹ fail 0' }), false);
  assert.equal(verificationFailureOf({ text: 'ℹ pass 3\nℹ fail 1' }), true);
  assert.equal(verificationFailureOf({ exit: 0, text: '# pass 1\n# fail 1' }), true);
  assert.equal(verificationFailureOf({ text: 'TypeError: cannot read properties of undefined' }), true);
});

test('a passing summary with cancelled tests does not verify a completed run', () => {
  for (const prefix of ['#', 'ℹ']) {
    const counts = `${prefix} pass 1\n${prefix} fail 0\n${prefix} cancelled `;
    assert.equal(verificationFailureOf({ text: `${counts}1` }), true, prefix);
    assert.equal(verificationFailureOf({ text: `${counts}0` }), false, prefix);
  }
});

test('redirect operands are data, while the executable can follow a redirect', () => {
  for (const command of ['echo >&npm test', 'echo >|npm test', 'echo &>npm test', 'echo > npm test',
    'echo >& npm test', 'npm2>test.log test', 'npm 2&>test.log test', "bash -c 'echo >&npm test'"]) {
    assert.equal(isVerificationCommand(command), false, command);
  }
  for (const command of ['>test.log npm test', '2>&1 npm test', '> "check output.log" npm test',
    'npm test 2>&1', 'npm >test.log test', 'cd app&&>test.log npm test', 'echo >&npm test | npm run lint',
    "env CI=1 bash -c '2>&1 npm test'"]) {
    assert.equal(isVerificationCommand(command), true, command);
  }
});

test('a heredoc body that names a check is data, not a check; the command lines still count', () => {
  const editsReadme = "python3 - <<'EOF'\ntext = 'run npm test, then make'\nprint(text)\nEOF";
  assert.equal(isVerificationCommand(editsReadme), false);
  assert.equal(isVerificationCommand("cat > notes.md <<EOF\nmake build\nEOF\nnpm test"), true);
  assert.equal(isVerificationCommand('npm test <<EOF\nanswers\nEOF'), true);
});
