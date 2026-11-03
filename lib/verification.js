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

function withoutShellData(command) {
  const input = withoutHeredocBodies(command).replace(WINDOWS_PATH, (path) => path.replaceAll('\\', '/'));
  let depth = 0;
  let start = 0;
  let output = '';
  for (const { 0: token, index } of input.matchAll(SHELL_TOKEN)) {
    if (depth === 0) {
      if (token === '(' || token === ')') continue;
      output += input.slice(start, index) + '\0';
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
  /^env\s+(?:(?:-i|--ignore-environment)\s+|[A-Za-z_]\w*=\S*\s+)*(?:--\s+)?/,
  /^npx\s+(?:(?:-y|--yes|--no-install)\s+|(?:-p|--package)(?:=\S+|\s+\S+)\s+)*(?:--\s+)?/,
  /^(?:sudo|time|nohup|bunx)\s+(?:--\s+)?/,
  /^timeout\s+\d+(?:\.\d+)?[smhd]?\s+/,
  /^(?:uv|poetry)\s+run\s+/,
  /^python(?:3(?:\.\d+)?)?\s+-m\s+(?=pytest(?:\s|$))/,
  /^yarn\s+(?=(?:jest|vitest)(?:\s|$))/,
];
const withoutExecutablePath = (command) => command.replace(/^\S+/, (token) => token.split('/').at(-1).replace(/\.exe$/i, ''));

export function isVerificationCommand(command) {
  if (typeof command !== 'string') return false;
  return withoutShellData(command).split(/[;&|\r\n]+/).some((part) => {
    let check = part.trim().replace(/^(?:(?:if|then|elif|else|do)\s+|[({]\s*)+/, '');
    while (check) {
      const wrapper = WRAPPERS.find((pattern) => pattern.test(check));
      const executable = wrapper ? check : withoutExecutablePath(check);
      const prefix = wrapper ?? WRAPPERS.find((pattern) => pattern.test(executable));
      if (!prefix) return VERIFICATION_COMMANDS.some((pattern) => pattern.test(executable));
      check = executable.replace(prefix, '');
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
