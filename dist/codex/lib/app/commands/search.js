// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { promptTextOf, recallStrategy, taskTextOf } from '../../recall.js';
import { sessionOf } from '../../session/state.js';
import { failure, success } from './result.js';

// A searched strategy is offered to the conversation; where the host shows the answer to the model, the driver
// adopts it into the session's ledger (`adoptStrategy`), so a turn's end reports its reuse like a recalled one's.
// The person's own words are the task the Hub judges each candidate against, as it does a recall's.
export default {
  name: 'evolver-search',
  description: 'Find the EvoMap strategy that best fits a task; where the agent sees the answer, its reuse is reported.',
  hint: '<task description or error text>',
  async run({ sessions, proxy }, { sessionId, args }) {
    const query = promptTextOf(args);
    if (!query) return failure('Usage: /evolver-search <task description or error text>');
    const session = sessionOf(await sessions.read(sessionId));
    const proxyFetch = (method, path, body) => proxy.request(method, path, body);
    const match = await recallStrategy(proxyFetch, query, {
      context: { task: taskTextOf(args), trigger: 'search' },
      listedIds: new Set(Object.keys(session.injected)),
      closingOf: () => 'Apply them where they fit.',
    });
    if (match.ids.length === 0) return success(`No EvoMap strategy relevant enough to "${query.slice(0, 60)}" was found.`);
    return success(match.text, { strategy: match });
  },
};
