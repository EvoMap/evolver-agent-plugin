// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// Codex rollout records: what one turn ran, edited and answered. Codex writes
// each turn twice, as `event_msg` and as `response_item`; only `response_item`
// is read, so nothing is counted twice. A call and its output share `call_id`.
// In code mode (Codex 0.144) the model sends one `exec` script that calls
// `tools.exec_command` and `tools.apply_patch`; each command's result comes
// back as one JSON part carrying its `exit_code`, in the order the calls ran.

import { isVerificationCommand, verificationFailed } from '../verification.js';

const SHELL_TOOLS = new Set(['shell', 'shell_command', 'exec_command', 'local_shell', 'container.exec']);
const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh', '/bin/bash', '/bin/sh', '/bin/zsh']);
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/;
const SCRIPT_COMMAND = /tools\.exec_command\(\s*\{[^}]*?\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
const SCRIPT_PATCH = /tools\.apply_patch\(/;

function recordsOf(chunk) {
  return String(chunk ?? '')
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((record) => record?.type === 'response_item' && record.payload && typeof record.payload === 'object')
    .map((record) => record.payload);
}

function parsedArguments(value) {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : {};
  try {
    return JSON.parse(value);
  } catch {
    return { input: value };
  }
}

// `["bash", "-lc", "npm test"]` ran `npm test`; the wrapper is how Codex spawns it.
function commandOf(args) {
  const command = args.command ?? args.cmd;
  if (typeof command === 'string') return command;
  if (!Array.isArray(command)) return '';
  const words = command.map(String);
  if (SHELL_WRAPPERS.has(words[0]) && /^-l?c$/.test(words[1] ?? '')) return words.slice(2).join(' ');
  return words.join(' ');
}

function outputOf(payload) {
  const raw = payload.output;
  if (typeof raw !== 'string') return { text: JSON.stringify(raw ?? ''), exitCode: undefined };
  try {
    const parsed = JSON.parse(raw);
    const exitCode = parsed?.metadata?.exit_code ?? parsed?.exit_code;
    return { text: String(parsed?.output ?? raw), exitCode: Number.isInteger(exitCode) ? exitCode : undefined };
  } catch {
    const match = /^Exit code:\s*(-?\d+)/.exec(raw);
    return { text: raw, exitCode: match ? Number(match[1]) : undefined };
  }
}

function patchOf(text) {
  const lines = String(text ?? '').split('\n');
  const paths = lines.map((line) => PATCH_FILE.exec(line)?.[1]?.trim()).filter(Boolean);
  const written = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).map((line) => line.slice(1));
  const changed = lines.filter((line) => /^[+-]/.test(line) && !/^(?:\+\+\+|---)/.test(line)).length;
  return { paths, written: written.join('\n'), changed };
}

function literalOf(quoted) {
  if (quoted.startsWith('"')) {
    try {
      return JSON.parse(quoted);
    } catch {
      return quoted.slice(1, -1);
    }
  }
  return quoted.slice(1, -1).replace(/\\(.)/g, (_, escaped) => (escaped === 'n' ? '\n' : escaped));
}

function scriptOf(input) {
  const script = String(input ?? '');
  const commands = [...script.matchAll(SCRIPT_COMMAND)].map((match) => literalOf(match[1]));
  const patch = SCRIPT_PATCH.test(script) ? patchOf(script.replace(/\\n/g, '\n')) : null;
  return { commands, patch };
}

function exitCodesOf(output) {
  const parts = Array.isArray(output) ? output.map((part) => part?.text) : [output];
  return parts.flatMap((text) => {
    try {
      const parsed = JSON.parse(String(text));
      return Number.isInteger(parsed?.exit_code) ? [{ exitCode: parsed.exit_code, text: String(parsed.output ?? '') }] : [];
    } catch {
      return [];
    }
  });
}

function addPatch(turn, patch) {
  turn.paths.push(...patch.paths);
  if (patch.written) turn.edits.push(patch.written);
  turn.changedLines += patch.changed;
}

function assistantTextOf(payload) {
  if (payload.type !== 'message' || payload.role !== 'assistant' || !Array.isArray(payload.content)) return '';
  return payload.content
    .filter((part) => part?.type === 'output_text' || part?.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('');
}

export function codexTurnOf(chunk) {
  const turn = { checks: [], commands: [], paths: [], edits: [], changedLines: 0, answer: '' };
  const pendingShell = new Map();
  const pendingScripts = new Map();
  for (const payload of recordsOf(chunk)) {
    const name = String(payload.name ?? '');
    if (payload.type === 'custom_tool_call' && name === 'exec') {
      const script = scriptOf(payload.input);
      turn.commands.push(...script.commands);
      if (script.patch) addPatch(turn, script.patch);
      if (payload.call_id && script.commands.length > 0) pendingScripts.set(payload.call_id, script.commands);
    } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const args = parsedArguments(payload.arguments ?? payload.input);
      if (name === 'apply_patch') {
        addPatch(turn, patchOf(args.input ?? args.patch ?? payload.input));
      } else if (SHELL_TOOLS.has(name)) {
        const command = commandOf(args);
        if (command) {
          turn.commands.push(command);
          if (typeof args.workdir === 'string') turn.paths.push(args.workdir);
          if (payload.call_id && isVerificationCommand(command)) pendingShell.set(payload.call_id, command);
        }
      }
    } else if (pendingScripts.has(payload.call_id)) {
      const commands = pendingScripts.get(payload.call_id);
      pendingScripts.delete(payload.call_id);
      const results = exitCodesOf(payload.output);
      commands.forEach((command, index) => {
        const result = results[index];
        if (!result || !isVerificationCommand(command)) return;
        turn.checks.push({ command: command.slice(0, 200), failed: result.exitCode !== 0 });
      });
    } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const command = pendingShell.get(payload.call_id);
      if (!command) continue;
      pendingShell.delete(payload.call_id);
      const { text, exitCode } = outputOf(payload);
      const failed = exitCode !== undefined ? exitCode !== 0 : verificationFailed({ text });
      turn.checks.push({ command: command.slice(0, 200), failed });
    } else {
      const text = assistantTextOf(payload);
      if (text) turn.answer = text;
    }
  }
  return turn;
}
