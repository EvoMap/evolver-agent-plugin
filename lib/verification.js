// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { detectSignals } from './signals.js';

// A turn reached its goal unless the last check it ran says otherwise: the
// verdict an automatic reuse report carries is read off the final test, build,
// lint or type-check command, never off how the turn ended.
const VERIFICATION_COMMANDS = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|type-check|check)\b/,
  /^node\s+--test\b/,
  /^(?:jest|vitest|mocha|pytest|rspec|phpunit|tsc|eslint|ruff|mypy)(?:\s|$)/,
  /^go\s+(?:test|build|vet)\b/,
  /^cargo\s+(?:test|build|check|clippy)\b/,
  /^dotnet\s+(?:test|build)\b/,
  /^(?:mvn|gradle|gradlew)(?:\s|$)/,
  /^make(?:\s|$)/,
  /^claude\s+plugin\s+(?:validate|test)\b/,
];

const FAILURE_SIGNALS = new Set(['test_failure', 'log_error']);

// Summaries of a passing run still name failures by count ("0 failed",
// "failures: 0"); only those counts are dropped, so "1 failed, 0 errors"
// still reads as a failure.
const ZERO_COUNT = /\b0\s+(?:failed|failures?|errors?)\b|\b(?:failed|failures?|errors?)\s*[:=]\s*0\b/gi;

// A heredoc body is data the command feeds a program, often prose that names `make` or `npm test`; only the command
// lines say what runs.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g;

const withoutHeredocBodies = (command) => command.replace(HEREDOC, '<<$2$3');

// Keep separators inside strings, backticks and comments out of the command scan. A name in an argument is no
// check. This recognises direct commands and known wrappers; it does not evaluate arbitrary shell control flow.
const SHELL_TOKEN = /\\[\s\S]|\x60[^\x60]*(?:\x60|$)|'(?:''|[^'])*(?:'|$)|"(?:\\[\s\S]|\x60[\s\S]|[^"\\\x60])*(?:"|$)|(?<![^\s;&|()])#[^\r\n]*|\$\(|[()]/g;
const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[\w.-]+\\)*[\w.-]+/g;

function withoutShellData(command, quotedExecutables) {
  const input = withoutHeredocBodies(command).replace(WINDOWS_PATH, (path) => path.replaceAll('\\', '/'));
  let depth = 0;
  let start = 0;
  let output = '';
  for (const { 0: token, index } of input.matchAll(SHELL_TOKEN)) {
    if (depth === 0) {
      if (token === '(' || token === ')') continue;
      const executable = literalExecutable(token);
      const masked = executable ? '\0' + (quotedExecutables.push(executable) - 1) + '\0' : '\0';
      output += input.slice(start, index) + masked;
      start = index + token.length;
    }
    if (token === '$(' || (depth > 0 && token === '(')) depth += 1;
    if (depth > 0 && token === ')') {
      depth -= 1;
      if (depth === 0) start = index + 1;
    }
  }
  return depth === 0 ? output + input.slice(start) : output;
}

const WRAPPERS = [
  /^(?:[A-Za-z_]\w*=\S*\s+)+/,
  /^env\s+(?:(?:-i|--ignore-environment)\s+|(?:-u|--unset|-C|--chdir)(?:=\S+|\s+\S+)\s+|[A-Za-z_]\w*=\S*\s+)*(?:--\s+)?/,
  /^npx\s+(?:(?:-y|--yes|--no-install)\s+|(?:-p|--package)(?:=\S+|\s+\S+)\s+)*(?:--\s+)?/,
  /^sudo\s+(?:(?:-n|--non-interactive)\s+|(?:-u|--user|-g|--group)(?:=\S+|\s+\S+)\s+)*(?:--\s+)?/,
  /^time\s+(?:(?:-p|--portability)\s+)?(?:--\s+)?/,
  /^(?:nohup|bunx|exec|!)\s+(?:--\s+)?/,
  /^timeout\s+(?:(?:--foreground|--preserve-status)\s+|(?:-s|--signal)(?:=\S+|\s+\S+)\s+)*(?:--\s+)?\d+(?:\.\d+)?[smhd]?\s+/,
  /^(?:uv|poetry)\s+run\s+/,
  /^python(?:3(?:\.\d+)?)?\s+-m\s+(?=pytest(?:\s|$))/,
  /^yarn\s+(?=(?:jest|vitest)(?:\s|$))/,
];
const executableName = (path) => path.split('/').at(-1).replace(/\.(?:exe|cmd|bat)$/i, '');

function literalExecutable(token) {
  const quote = token[0];
  if ((quote !== "'" && quote !== '"') || token.length < 2 || !token.endsWith(quote)) return null;
  const path = token.slice(1, -1);
  const windows = /^[A-Za-z]:[\\/]/.test(path);
  if (quote === '"' && (/[#$%!\x60"]/.test(path) || (!windows && path.includes('\\')))) return null;
  const name = executableName(windows ? path.replaceAll('\\', '/') : path);
  return /^[\w.-]+$/.test(name) ? name : null;
}

function withoutExecutablePath(command, quotedExecutables) {
  return command.replace(/^\S+/, (token) => {
    const quoted = /^\0(\d+)\0$/.exec(token);
    if (quoted) return quotedExecutables[Number(quoted[1])];
    return token.includes('\0') ? token : executableName(token);
  });
}

// Only unwrap a literal script passed directly to a shell. Expansions in a double-quoted script belong to the outer shell.
const SHELL_SCRIPT = /^(?:bash|sh)\s+-c\s+(?:'([^']*)'|"([^"\x60$\\]*)")$/;

function shellCommandOf(command) {
  const script = SHELL_SCRIPT.exec(command.trim());
  return script ? script[1] ?? script[2] : command;
}

export function isVerificationCommand(command) {
  if (typeof command !== 'string' || command.includes('\0')) return false;
  const quotedExecutables = [];
  return withoutShellData(shellCommandOf(command), quotedExecutables).split(/[;&|\r\n]+/).some((part) => {
    let check = part.trim().replace(/^(?:(?:if|then|elif|else|do)\s+|[({]\s*)+/, '');
    while (check) {
      // An assignment may contain slashes but is still a wrapper before the executable.
      if (!/^[A-Za-z_]\w*=/.test(check)) check = withoutExecutablePath(check, quotedExecutables);
      const wrapper = WRAPPERS.find((pattern) => pattern.test(check));
      if (!wrapper) return VERIFICATION_COMMANDS.some((pattern) => pattern.test(check));
      check = check.replace(wrapper, '');
    }
    return false;
  });
}

/** @param {{ isError?: boolean, text?: string }} result */
export function verificationFailed({ isError, text }) {
  if (isError) return true;
  const evidence = String(text ?? '').replace(ZERO_COUNT, '');
  return detectSignals(evidence).some((signal) => FAILURE_SIGNALS.has(signal));
}

// Codex and some older/text-only host results omit the process exit code. A complete Node/TAP summary is
// positive evidence; ordinary output or just the absence of failure words is not. Failure always wins.
const PASSED_COUNT = /^\s*(?:#|ℹ)\s+pass\s+[1-9]\d*\b/m;
const ZERO_FAILED_COUNT = /^\s*(?:#|ℹ)\s+fail\s+0\b/m;
const FAILED_COUNT = /^\s*(?:#|ℹ)\s+(?:fail|cancelled)\s+[1-9]\d*\b/m;

const SHELL_CONTROL = /[;&|()\r\n]|(?:^|[ \t])!(?:[ \t]|$)|^(?:if|then|elif|else|do|\{)(?:\s|$)/;

function checkExitOf(command, exit) {
  if (!Number.isInteger(exit) || typeof command !== 'string') return exit;
  const shell = withoutShellData(shellCommandOf(command), []).replace(/[<>]&|&>|>\|/g, ' ').trim();
  if (!SHELL_CONTROL.test(shell)) return exit;

  // A successful directory change followed by one check implies the check ran and passed.
  const [before, after, extra] = shell.split('&&', 3);
  if (exit === 0 && after && extra === undefined && /^cd\s+\S/.test(before)
    && !SHELL_CONTROL.test(before) && !SHELL_CONTROL.test(after.trim())) return exit;
  return null;
}

/** A finished check's failed flag: true = failed, false = passed, null = unknown. */
export function verificationFailureOf({ command, exit, text }) {
  const output = String(text ?? '');
  const checkExit = checkExitOf(command, exit);
  if (verificationFailed({ isError: Number.isInteger(checkExit) && checkExit !== 0, text: output }) || FAILED_COUNT.test(output)) return true;
  if (checkExit === 0 || (PASSED_COUNT.test(output) && ZERO_FAILED_COUNT.test(output))) return false;
  return null;
}
