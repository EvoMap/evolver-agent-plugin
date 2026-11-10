// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { isAbsolute, resolve } from 'node:path';

const factsOf = (context) => context?.nativeFacts?.status === 'ok' && context.nativeFacts.schemaSupported
  ? context.nativeFacts
  : null;

export function editedFilesOf(payload, context = {}) {
  const facts = factsOf(context);
  if (payload.hook_event_name !== 'PreToolUse' || !['Write', 'Edit'].includes(payload.tool_name)
      || facts?.toolTurnId == null) return [];
  const file = payload.tool_input?.path;
  if (typeof file !== 'string' || !file || file.includes('\0')) return [];
  return isAbsolute(file)
    ? [file]
    : typeof payload.cwd === 'string' && isAbsolute(payload.cwd) ? [resolve(payload.cwd, file)] : [];

}

export const kimiEvidence = Object.freeze({
  // Kimi truncates hook tool_output. Only correlated native wire/task results can settle evidence.
  toolNote: () => null,
  editedFiles: editedFilesOf,
  turnStart: (payload, context = {}) => context.nativeFacts?.mark ?? null,
  turnRecord: (payload, context = {}) => factsOf(context)?.record ?? null,
});
