// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { draftNamed, draftsListText, submitRequestOf, withoutDraft } from '../../distill.js';
import { DISTILL_TIMEOUT_MS } from '../distill-session.js';
import { failure, success } from './result.js';

const USAGE = 'Usage: /evolver-drafts [publish|discard <number>]';

function reverifiedOf(result) {
  const assets = result?.assets, receipt = result?.publish_receipt;
  if (result?.ok !== true || result.publishable !== true || !Array.isArray(assets) || assets.length < 2 || assets.length > 3) return null;
  if (!assets.every(asset => asset && ['Gene', 'Capsule', 'EvolutionEvent'].includes(asset.type) && typeof asset.asset_id === 'string' && asset.asset_id)) return null;
  if (assets.filter(asset => asset.type === 'Gene').length !== 1 || assets.filter(asset => asset.type === 'Capsule').length !== 1) return null;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.version !== 'publish-binding.v1') return null;
  const fields = ['bundleDigest', 'inputDigest', 'validationDigest', 'runtimeDigest', 'rootFingerprint', 'executionDigest', 'receiptId'];
  if (!fields.every(field => typeof receipt[field] === 'string' && receipt[field])) return null;
  return { assets, publish_receipt: receipt, publishable: true };
}

async function discard({ drafts, clock }, draft) {
  await drafts.update((list) => withoutDraft(list, draft.id, clock.now()));
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
    await ports.drafts.update(list => {
      if (!list.some(existing => JSON.stringify(existing) === JSON.stringify(draft))) return undefined;
      saved = true;
      return list.map(existing => existing.id === draft.id ? next : existing);
    });
    if (!saved) return failure(`"${draft.title}" changed or was discarded during verification; it was not submitted.`);
    draft = next;
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
