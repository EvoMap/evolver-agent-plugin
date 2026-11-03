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
const SHELL_DATA = /\\[\s\S]|`[^`]*(?:`|$)|'(?:''|[^'])*(?:'|$)|"(?:\\[\s\S]|`[\s\S]|[^"\\`])*(?:"|$)|#[^\r\n]*/g;
const ENVIRONMENT = /^(?:env\s+)?(?:[A-Za-z_]\w*=\S*\s+)*/;
const NPX = /^npx\s+(?:(?:-y|--yes|--no-install)\s+|(?:-p|--package)(?:=\S+|\s+\S+)\s+)*(?:--\s+)?/;
const withoutExecutablePath = (command) => command.replace(/^\S+/, (token) => token.split(/[\\/]/).at(-1));

export function isVerificationCommand(command) {
  if (typeof command !== 'string') return false;
  const shell = withoutHeredocBodies(command).replace(SHELL_DATA, '__data__');
  if (shell.includes('$(')) return false; // Do not mistake separators in a nested substitution for command positions.
  const commands = shell.split(/[;&|\r\n]+/);
  return commands.some((part) => {
    const executable = withoutExecutablePath(part.trim().replace(ENVIRONMENT, ''));
    const check = withoutExecutablePath(executable.replace(NPX, ''));
    return VERIFICATION_COMMANDS.some((pattern) => pattern.test(check));
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

/** A finished check's failed flag: true = failed, false = passed, null = unknown. */
export function verificationFailureOf({ exit, text }) {
  const output = String(text ?? '');
  if (verificationFailed({ isError: Number.isInteger(exit) && exit !== 0, text: output }) || FAILED_COUNT.test(output)) return true;
  if (exit === 0 || (PASSED_COUNT.test(output) && ZERO_FAILED_COUNT.test(output))) return false;
  return null;
}
