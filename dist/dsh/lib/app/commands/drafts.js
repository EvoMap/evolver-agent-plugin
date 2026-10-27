// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { draftNamed, draftsListText, submitRequestOf, withoutDraft } from '../../distill.js';
import { failure, success } from './result.js';

const USAGE = 'Usage: /evolver-drafts [publish|discard <number>]';

async function discard({ drafts, clock }, draft) {
  await drafts.update((list) => withoutDraft(list, draft.id, clock.now()));
  return success(`Discarded "${draft.title}".`);
}

async function publish(ports, draft) {
  const request = submitRequestOf(draft);
  const answered = await ports.proxy.request(request.method, request.path, request.body);
  if (!answered.ok) return failure(`"${draft.title}" was not submitted: ${answered.error}`);
  await ports.drafts.update((list) => withoutDraft(list, draft.id, ports.clock.now()));
  return success(`Submitted "${draft.title}" to the EvoMap Hub for review (message ${answered.data?.message_id ?? 'pending'}).`);
}

export default {
  name: 'evolver-drafts',
  description: 'List distilled drafts; publish one to the EvoMap Hub for review, or discard it.',
  hint: '[publish|discard <number>]',
  async run(ports, { args }) {
    const [action = '', selector = ''] = args.trim().split(/\s+/);
    const list = withoutDraft(await ports.drafts.read(), null, ports.clock.now());
    if (!action) return success(draftsListText(list));
    if (action !== 'publish' && action !== 'discard') return failure(USAGE);
    const draft = draftNamed(list, selector);
    if (!draft) return failure(`No draft matches "${selector}".\n\n${draftsListText(list)}`);
    return action === 'publish' ? publish(ports, draft) : discard(ports, draft);
  },
};
