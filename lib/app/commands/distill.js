// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { distillSession } from '../distill-session.js';
import { failure, shown, success } from './result.js';

export function distillText(outcome) {
  switch (outcome.status) {
    case 'nothing': return failure('Nothing to distill yet: no turn of this session finished verified.');
    case 'busy': return failure('Another process is distilling this session right now.');
    case 'declined': return success(`No Gene: the turn holds no method worth reusing (${outcome.reason}).`);
    case 'drafted': return success(`Distilled "${outcome.draft.title}" into a draft. Publish it with /evolver-drafts publish 1, or list drafts with /evolver-drafts.`);
    case 'stored': return success(shown(outcome.data ?? 'distilled'));
    case 'skipped': return failure(`The Proxy kept nothing: ${outcome.reason}.`);
    case 'unparsed': return failure('The Gene must be one JSON object with at least a "summary".');
    case 'dropped': return failure('A newer turn replaced the one this Gene was written for; nothing was sent.');
    default: return failure(`Distillation ${outcome.status}${outcome.error ? `: ${outcome.error}` : ''}.`);
  }
}

export default {
  name: 'evolver-distill',
  description: "Distill this session's latest verified turn into a draft Gene now, instead of at session end.",
  hint: '[focus]',
  async run(ports, { sessionId, args }) {
    const outcome = await distillSession(ports, { sessionId, focus: args });
    const answer = distillText(outcome);
    return outcome.agentGene ? { ...answer, agentGene: outcome.agentGene } : answer;
  },
};
