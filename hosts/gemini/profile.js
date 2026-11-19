// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { EVENTS } from '../../lib/agent/events.js';
import { defineProfile } from '../../lib/agent/profile.js';

const modelRequestEvent = 'BeforeModel';
const startupContext = /^\s*<session_context>\r?\nThis is the Gemini CLI\. We are setting up the context for our chat\.\r?\n[\s\S]*?<\/session_context>/;
const latestUserMessageOf = (messages) => {
  if (!Array.isArray(messages) || !messages.every((message) =>
    typeof message?.role === 'string' && typeof message.content === 'string')) return -1;
  return messages.findLastIndex(({ role }) => role === 'user');
};

export default defineProfile({
  name: 'gemini',
  label: 'Gemini CLI',
  events: {
    SessionStart: EVENTS.SESSION_START,
    BeforeAgent: EVENTS.PROMPT,
    BeforeModel: EVENTS.PROMPT,
    SessionEnd: EVENTS.SESSION_END,
  },
  recallOnly: {
    requestEvent: modelRequestEvent,
    requestOf(payload) {
      const messages = payload.llm_request?.messages;
      const target = latestUserMessageOf(messages);
      if (target < 0) return null;
      // Gemini flattens its startup context and the first prompt into a single text message.
      const prompt = messages[target].content.replace(startupContext, '');
      return { prompt, history: messages.slice(0, target + 1) };
    },
  },
  owner: 'parent',
  windowsAncestry: true,
  drainWindowsHandles: true,
  budgets: { prompt: 10_000 },
  stateDir: (env) => join(env.GEMINI_CLI_HOME || env.HOME || env.USERPROFILE || homedir(), '.gemini', 'evolver-plugin'),
  evidence: { toolNote: () => null, editedFiles: () => [] },
  payload: {
    isIgnored: (payload, { hostEvent }) => payload.hook_event_name !== hostEvent
      || typeof payload.session_id !== 'string' || !payload.session_id
      || typeof payload.cwd !== 'string' || !isAbsolute(payload.cwd),
    // Gemini can expand file and MCP references before it invokes the prompt hook.
    prompt: (payload) => typeof payload.prompt === 'string' && !payload.prompt.includes('--- Content from referenced files ---')
      ? payload.prompt
      : '',
  },
  reply: {
    // shortcut: the 0.69.0 hook view flattens text parts, until Gemini exposes a request-only context field.
    context: (recipe, hostEvent, payload) => {
      const messages = payload.llm_request.messages;
      const target = latestUserMessageOf(messages);
      const context = '<hook_context>' + recipe.replace(/<(?=\/?hook_context\b)/gi, '&lt;') + '</hook_context>';
      return {
        hookSpecificOutput: {
          hookEventName: hostEvent,
          llm_request: { messages: messages.map((message, index) =>
            index === target ? { ...message, content: [message.content, context].join('\n\n') } : message) },
        },
      };
    },
  },
});
