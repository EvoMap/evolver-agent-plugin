// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { draftNamed, draftsListText, reverifiedOf, submitRequestOf, withoutDraft } from '../../distill.js';
import { DISTILL_TIMEOUT_MS } from '../distill-session.js';
import { failure, success } from './result.js';

const USAGE = 'Usage: /evolver-drafts [publish|discard <number>]';

async function discard({ drafts }, draft) {
  await drafts.update((list) => withoutDraft(list, draft.id));
  return success(`Discarded "${draft.title}".`);
}

async function publish(ports, draft, signal) {
  if (draft.publishable === false || !draft.publish_receipt) {
    const verified = await ports.proxy.request('POST', '/asset/reverify', { assets: draft.assets, persist: false }, { timeoutMs: DISTILL_TIMEOUT_MS, signal });
    const promoted = verified.ok && reverifiedOf(verified.data);
    if (!promoted) {
      return failure(`"${draft.title}" needs trusted Proxy verification before publication: ${verified.error ?? verified.data?.error ?? 'invalid reverification response'}. The draft was kept.`);
    }
    const next = { ...draft, ...promoted };
    let saved = false;
    await ports.drafts.update((list) => {
      const current = list.find((existing) => existing.id === draft.id);
      if (!current || current.createdAt !== draft.createdAt
        || current.publishable !== draft.publishable
        || Boolean(current.publish_receipt) !== Boolean(draft.publish_receipt)) return undefined;
      saved = true;
      return list.map((existing) => existing === current ? next : existing);
    });
    if (!saved) return failure(`"${draft.title}" changed or was discarded during verification; it was not submitted.`);
    draft = next;
  }
  const request = submitRequestOf(draft);
  const answered = await ports.proxy.request(request.method, request.path, request.body, { signal });
  if (!answered.ok) return failure(`"${draft.title}" was not submitted: ${answered.error}`);
  await ports.drafts.update((list) => withoutDraft(list, draft.id));
  return success(`Submitted "${draft.title}" to the EvoMap Hub for review (message ${answered.data?.message_id ?? 'pending'}).`);
}

export default {
  name: 'evolver-drafts',
  description: 'List distilled drafts; publish one to the EvoMap Hub for review, or discard it.',
  hint: '[publish|discard <number>]',
  async run(ports, { args, signal }) {
    const [action = '', selector = ''] = args.trim().split(/\s+/);
    const list = await ports.drafts.read();
    if (!action) return success(draftsListText(list));
    if (action !== 'publish' && action !== 'discard') return failure(USAGE);
    const draft = draftNamed(list, selector);
    if (!draft) return failure(`No draft matches "${selector}".\n\n${draftsListText(list)}`);
    return action === 'publish' ? publish(ports, draft, signal) : discard(ports, draft);
  },
};
