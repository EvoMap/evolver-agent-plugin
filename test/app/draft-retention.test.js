import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCommand } from '../../lib/app/commands/index.js';
import { withDraft } from '../../lib/distill.js';
import { memoryPorts } from './memory-ports.js';

test('adding and listing drafts preserves old, legacy and more than twenty unreviewed drafts', async () => {
  const { ports } = memoryPorts();
  const earlier = Array.from({ length: 25 }, (_, i) => ({ id: `old-${i}`, title: `Old method ${i}`, summary: '', assets: [], createdAt: 0 }));
  earlier.push({ id: 'legacy', title: 'Legacy method', summary: '', assets: [] });
  await ports.drafts.update(() => earlier);
  await ports.clock.sleep(9 * 24 * 60 * 60 * 1000);
  const added = { id: 'new', title: 'New method', summary: '', assets: [], createdAt: ports.clock.now() };
  await ports.drafts.update((list) => withDraft(list, added));
  const list = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts' });
  assert.match(list.text, /27 distilled drafts waiting/);
  assert.match(list.text, /1\. Old method 0/);
  assert.deepEqual(await ports.drafts.read(), [...earlier, added]);
  const discarded = await runCommand(ports, { sessionId: 's1', name: 'evolver-drafts', args: 'discard 1' });
  assert.equal(discarded.ok, true);
  assert.deepEqual(await ports.drafts.read(), [...earlier.slice(1), added]);
});
