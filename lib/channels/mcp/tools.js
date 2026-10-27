// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { z } from 'zod';

import { MCP_TOOLS } from '../../agent/defaults/mcp.js';

// Six tools, one per thing an agent without hooks has to tell Evolver or ask of it. They are thin: each is a
// canonical event or command of the same driver every hook host goes through.
export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: MCP_TOOLS.RECALL,
    description: 'Call once when you start a task: returns a proven strategy for it from EvoMap, or says there is none.',
    input: { task: z.string().min(1).describe("The person's request, as they wrote it."), project_dir: z.string().optional() },
  },
  {
    name: MCP_TOOLS.REPORT,
    description: 'Call once when the task ends: how it went and which checks (tests, builds, linters, type checks) you ran.',
    input: {
      turn_id: z.string().min(1).describe('The turn_id evolver_recall answered for this task.'),
      outcome: z.enum(['success', 'failed', 'aborted']),
      summary: z.string().describe('Your final answer in one or two sentences.'),
      checks: z.array(z.object({ command: z.string(), exit: z.number().int() })).default([]),
      files: z.array(z.string()).default([]).describe('Files you changed.'),
      project_dir: z.string().optional(),
    },
  },
  {
    name: MCP_TOOLS.DISTILL,
    description: 'Only when a report asked for it: the reusable Gene you wrote for that turn, or {"skip": "<why>"}.',
    input: { written_for: z.number().int(), gene: z.union([z.string(), z.record(z.string(), z.unknown())]) },
  },
  { name: MCP_TOOLS.STATUS, description: 'Evolver health: Proxy, engine setup, distillation candidate and drafts.', input: {} },
  { name: MCP_TOOLS.SEARCH, description: 'Find the EvoMap strategy that best fits a task.', input: { query: z.string().min(1) } },
  {
    name: MCP_TOOLS.DRAFTS,
    description: 'List distilled drafts. Publish one to the EvoMap Hub for review, or discard it, only when the person asks you to.',
    input: { args: z.string().default('').describe('Empty to list, or "publish <number>" / "discard <number>".') },
  },
]);
