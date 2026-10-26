// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { turnRecordOf } from '../../lib/turn/record.js';
import { stepsAfter, turnActivityOf } from './transcript.js';

// Hooks get no tool output and no exit code: Antigravity writes the exit code into the command's result step
// (`The command exited with code 2.`), so every call of a turn is read back from the transcript as a tool note.

export const SHELL_TOOL = 'run_command';
export const EDIT_TOOLS = Object.freeze(['write_to_file', 'replace_file_content', 'multi_replace_file_content']);

const PATH_KEYS = ['TargetFile', 'AbsolutePath', 'DirectoryPath', 'SearchPath', 'SearchDirectory'];
const COMPLETED = new Set(['DONE', 'ERROR']);
const EXIT_LINE = /^The command exited with code (-?\d+)\./m;
const EXIT_IN_ERROR = /\bexit (?:status|code)\D*(-?\d+)/i;
const OUTPUT_MARKER = /^Output:\n?/m;
const FAILED_WITHOUT_CODE = 1;

const isFailed = (result) => !result || result.status === 'ERROR' || Boolean(result.error);

/** The file an edit is about to change, or null for any other tool call. */
export function editedFileOf(toolCall) {
  const file = EDIT_TOOLS.includes(toolCall?.name) ? toolCall.args?.TargetFile : null;
  return typeof file === 'string' && file ? file : null;
}

function exitCodeOf(result) {
  const match = EXIT_LINE.exec(String(result.content ?? '')) ?? EXIT_IN_ERROR.exec(String(result.error ?? ''));
  if (match) return Number(match[1]);
  return isFailed(result) ? FAILED_WITHOUT_CODE : null;
}

function outputOf(content) {
  const text = String(content ?? '');
  const marker = OUTPUT_MARKER.exec(text);
  return marker ? text.slice(marker.index + marker[0].length) : text;
}

// A command with no result step, or one whose step has not completed (moved to the background), has no verdict.
function shellNote(command, result) {
  if (!result || !COMPLETED.has(result.status)) return { kind: 'shell', command, running: true };
  return { kind: 'shell', command, exit: exitCodeOf(result), output: outputOf(result.content) };
}

function noteOf({ name, args, result }) {
  const paths = PATH_KEYS.map((key) => args[key]).filter((value) => typeof value === 'string' && value);
  if (name === SHELL_TOOL && typeof args.CommandLine === 'string') return { ...shellNote(args.CommandLine, result), paths };
  return { kind: EDIT_TOOLS.includes(name) && !isFailed(result) ? 'edit' : 'tool', paths };
}

/** What the turn the marked prompt opened did, from the transcript's steps up to the next prompt. */
export function transcriptRecordOf(steps, mark) {
  const { calls, answer } = turnActivityOf(stepsAfter(steps, mark));
  return { ...turnRecordOf(calls.map(noteOf)), answer };
}
