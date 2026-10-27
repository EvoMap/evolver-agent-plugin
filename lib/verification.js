// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { detectSignals } from './signals.js';

// A turn reached its goal unless the last check it ran says otherwise: the
// verdict an automatic reuse report carries is read off the final test, build,
// lint or type-check command, never off how the turn ended.
const VERIFICATION_COMMANDS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|type-check|check)\b/,
  /\bnode\s+--test\b/,
  /\b(?:jest|vitest|mocha|pytest|rspec|phpunit|tsc|eslint|ruff|mypy)\b/,
  /\bgo\s+(?:test|build|vet)\b/,
  /\bcargo\s+(?:test|build|check|clippy)\b/,
  /\bdotnet\s+(?:test|build)\b/,
  /\b(?:mvn|gradle|gradlew)\b/,
  /\bmake\b/,
  /\bclaude\s+plugin\s+(?:validate|test)\b/,
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

export function isVerificationCommand(command) {
  return typeof command === 'string' && VERIFICATION_COMMANDS.some((pattern) => pattern.test(withoutHeredocBodies(command)));
}

/** @param {{ isError?: boolean, text?: string }} result */
export function verificationFailed({ isError, text }) {
  if (isError) return true;
  const evidence = String(text ?? '').replace(ZERO_COUNT, '');
  return detectSignals(evidence).some((signal) => FAILURE_SIGNALS.has(signal));
}
