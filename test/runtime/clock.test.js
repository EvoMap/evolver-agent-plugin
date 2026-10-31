import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { environmentFor } from '../../lib/runtime/environment.js';
import { runProcess } from '../../lib/runtime/process/spawn.js';

test('cancelling an unused recall deadline releases its timer and lets a hook exit naturally', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-clock-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const module = new URL('../../lib/runtime/environment.js', import.meta.url).href;
  const profile = `{name:'clock-test',label:'Clock',stateDir:()=>${JSON.stringify(dir)},legacy:[],turnEnd:{},commands:{},owner:'self'}`;
  const source = `import{environmentFor}from${JSON.stringify(module)};const{ports}=environmentFor({profile:${profile}});const controller=new AbortController();const waiting=ports.clock.sleep(60000,controller.signal);controller.abort();await waiting;console.log('CANCELLED');`;
  const result = await runProcess(process.execPath, ['--input-type=module', '-e', source], { timeoutMs: 5000 });
  assert.equal(result.code, 0, result.error?.message);
  assert.equal(result.stdout.trim(), 'CANCELLED');
  const { ports } = environmentFor({ profile: { name: 'clock-test', label: 'Clock', stateDir: () => dir, legacy: [], turnEnd: {}, commands: {}, owner: 'self' } });
  await ports.clock.sleep(1);
});
