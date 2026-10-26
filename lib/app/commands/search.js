// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { promptTextOf, recallStrategy } from '../../recall.js';
import { sessionOf, withInjection } from '../../session/state.js';
import { failure, success } from './result.js';

// A searched strategy joins the session's ledger like a recalled one, for the next turn, so that turn's end
// reports its reuse with the same evidence.
export default {
  name: 'evolver-search',
  description: 'Find the EvoMap strategy that best fits a task and add it to the conversation.',
  hint: '<task description or error text>',
  async run({ sessions, proxy, clock }, { sessionId, args }) {
    const query = promptTextOf(args);
    if (!query) return failure('Usage: /evolver-search <task description or error text>');
    const session = sessionOf(await sessions.read(sessionId));
    const proxyFetch = (method, path, body) => proxy.request(method, path, body);
    const match = await recallStrategy(proxyFetch, query, { listedIds: new Set(Object.keys(session.injected)), closingOf: () => 'Apply them where they fit.' });
    const [assetId] = match.ids;
    if (!assetId) return failure(`No EvoMap strategy relevant enough to "${query.slice(0, 60)}" was found.`);
    await sessions.update(sessionId, (stored) => withInjection(sessionOf(stored), assetId, { turn: session.turn + 1, strategyText: match.text }, clock.now()).next);
    return success(match.text);
  },
};
