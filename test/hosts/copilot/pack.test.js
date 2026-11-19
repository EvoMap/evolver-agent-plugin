// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { pack } from '../../../scripts/pack.mjs';

test('the packed root Copilot entry loads its adapter and the host-provided SDK', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'evolver-copilot-entry-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const out = join(scratch, 'bundle'), home = join(scratch, 'profile'), marker = join(scratch, 'sdk.json');
  mkdirSync(home);
  pack('copilot', out);
  const run = (headless) => spawnSync(process.execPath, [join(out, 'extension.mjs')], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, COPILOT_HOME: home, EVOLVER_HEADLESS: headless ? '1' : '', TEST_SDK_MARKER: marker },
    encoding: 'utf8', timeout: 8_000, windowsHide: true,
  });

  const headless = run(true);
  assert.ifError(headless.error);
  assert.equal(headless.status, 0, headless.stderr);
  assert.equal(existsSync(marker), false, 'headless completion must not load the native SDK');

  // Copilot supplies this package through its native resolver; the bundle must not install another SDK.
  const sdk = join(out, 'node_modules', '@github', 'copilot-sdk');
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@github/copilot-sdk', type: 'module', exports: { './extension': './extension.mjs' } }));
  writeFileSync(join(sdk, 'extension.mjs'), `
    import assert from 'node:assert/strict';
    import { writeFileSync } from 'node:fs';
    export async function joinSession({ hooks }) {
      return {
        sessionId: 'packed-fixture',
        on(listener) {
          assert.equal(typeof listener, 'function');
          writeFileSync(process.env.TEST_SDK_MARKER, JSON.stringify(Object.keys(hooks)));
          return () => {};
        },
      };
    }
  `);
  const native = run(false);
  assert.ifError(native.error);
  assert.equal(native.status, 0, native.stderr);
  const hooks = JSON.parse(readFileSync(marker, 'utf8'));
  assert.ok(hooks.includes('onUserPromptTransformed'));
  assert.ok(hooks.includes('onSessionEnd'));
});
