// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { MCP_TOOLS } from '../../agent/defaults/mcp.js';
import { profileNamed } from '../../agent/registry.js';
import { createPluginChannel } from '../plugin/adapter.js';
import { TOOL_DEFINITIONS } from './tools.js';

const SERVER_NAME = 'evolver-agent';

/**
 * The MCP channel: an stdio server for an agent without hooks. One server process serves one client connection,
 * which is the session; it starts on connect and ends when the client goes away. Each recall opens a turn named by
 * a fresh turn_id, which the report must name. A session start's engine notice has no reply of its own to ride, so
 * it leads the first recall's answer. Nothing is written to stdout but the
 * protocol itself.
 */
export function createMcpServer({ profile, env = process.env, overrides = {}, version = '0.0.0' }) {
  const channel = createPluginChannel({ profile, env, overrides });
  const sessionId = randomUUID();
  const server = new McpServer({ name: SERVER_NAME, version });
  let notice = [];
  let started = Promise.resolve();
  let previous = Promise.resolve();
  // Calls are handled one after another, in the order they came, so a report never races the next recall.
  const inOrder = (work) => {
    const done = previous.then(work);
    previous = done.catch(() => {});
    return done;
  };
  const answerOf = async (tool, args) => {
    await started;
    const turn = tool.name === MCP_TOOLS.RECALL ? { turn_id: randomUUID() } : {};
    const answer = await channel.handle(tool.name, { ...args, ...turn, session_id: sessionId });
    if (tool.name !== MCP_TOOLS.RECALL || notice.length === 0) return answer;
    const withNotice = { ...answer, content: [...notice, ...answer.content] };
    notice = [];
    return withNotice;
  };
  for (const tool of TOOL_DEFINITIONS) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, (args) => inOrder(() => answerOf(tool, args)));
  }
  return {
    server,
    sessionId,
    start: () => {
      started = channel.handle('initialize', { session_id: sessionId }).then((answer) => {
        notice = (answer.content ?? []).filter((part) => part.text);
      });
      return started;
    },
    // A closing client gives the server moments, not a delivery's worth: the session end only writes, and the
    // next session start delivers and distills what it left.
    close: async () => {
      channel.close();
      await inOrder(() => channel.handle('close', { session_id: sessionId }));
    },
  };
}

/** Runs the MCP server for `agent` on stdio until the client disconnects. */
export async function runMcpProcess(agent, { env = process.env, version } = {}) {
  const profile = await profileNamed(agent);
  if (!profile) throw new Error(`No agent named "${agent}".`);
  if (profile.channel !== 'mcp') throw new Error(`"${agent}" is not an MCP agent: it runs from its host's hooks.`);
  const mcp = createMcpServer({ profile, env, version });
  const transport = new StdioServerTransport();
  let closing = null;
  const shutDown = () => (closing ??= mcp.close().finally(() => process.exit(0)));
  transport.onclose = shutDown;
  process.stdin.on('end', shutDown);
  process.on('SIGTERM', shutDown);
  const starting = mcp.start();
  await mcp.server.connect(transport);
  await starting;
}
