// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { draftNamed, draftsListText, submitRequestOf, withoutDraft } from '../../distill.js';
import { DISTILL_TIMEOUT_MS } from '../distill-session.js';
import { failure, success } from './result.js';

const USAGE = 'Usage: /evolver-drafts [publish|discard <number>]';

async function discard({ drafts, clock }, draft) {
  await drafts.update((list) => withoutDraft(list, draft.id, clock.now()));
  return success(`Discarded "${draft.title}".`);
}

async function publish(ports, draft, signal) {
  if (draft.publishable === false) {
    const verified = await ports.proxy.request('POST', '/asset/reverify', { assets: draft.assets, persist: false }, { timeoutMs: DISTILL_TIMEOUT_MS, signal });
    const result = verified.data;
    if (!verified.ok || result?.ok !== true || result.publishable !== true || !Array.isArray(result.assets) || result.assets.length < 2 || !result.publish_receipt || typeof result.publish_receipt !== 'object') {
      return failure(`"${draft.title}" needs trusted Proxy verification before publication: ${verified.error ?? result?.error ?? 'invalid reverification response'}. The draft was kept.`);
    }
    const promoted = { ...draft, assets: result.assets, publish_receipt: result.publish_receipt, publishable: true };
    let saved = false;
    await ports.drafts.update(list => {
      if (!list.some(existing => JSON.stringify(existing) === JSON.stringify(draft))) return undefined;
      saved = true;
      return list.map(existing => existing.id === draft.id ? promoted : existing);
    });
    if (!saved) return failure(`"${draft.title}" changed or was discarded during verification; it was not submitted.`);
    draft = promoted;
  }
  const request = submitRequestOf(draft);
  const answered = await ports.proxy.request(request.method, request.path, request.body, { signal });
  if (!answered.ok) return failure(`"${draft.title}" was not submitted: ${answered.error}`);
  await ports.drafts.update((list) => withoutDraft(list, draft.id, ports.clock.now()));
  return success(`Submitted "${draft.title}" to the EvoMap Hub for review (message ${answered.data?.message_id ?? 'pending'}).`);
}

export default {
  name: 'evolver-drafts',
  description: 'List distilled drafts; publish one to the EvoMap Hub for review, or discard it.',
  hint: '[publish|discard <number>]',
  async run(ports, { args, signal }) {
    const [action = '', selector = ''] = args.trim().split(/\s+/);
    const list = withoutDraft(await ports.drafts.read(), null, ports.clock.now());
    if (!action) return success(draftsListText(list));
    if (action !== 'publish' && action !== 'discard') return failure(USAGE);
    const draft = draftNamed(list, selector);
    if (!draft) return failure(`No draft matches "${selector}".\n\n${draftsListText(list)}`);
    return action === 'publish' ? publish(ports, draft, signal) : discard(ports, draft);
  },
};
