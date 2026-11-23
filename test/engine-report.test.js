import assert from 'node:assert/strict';
import { test } from 'node:test';

import { engineSetupOf } from '../lib/engine/report.js';

const FAILED_ON_2050 = { version: '2.0.50', source: 'path', status: 'start_failed', error: 'the Proxy did not answer within the wait', at: 1794967906012, failures: 5, retryAt: 1794977506012 };

test('a setup failure recorded before a new enough Proxy came up is shown as the previous result, not as the current one', () => {
  assert.deepEqual(engineSetupOf(FAILED_ON_2050, '2.0.55', 'dsh'), {
    status: 'ready', previous: { status: 'start_failed', version: '2.0.50', at: '2026-11-18T02:11:46.012Z' },
  });
  const restartNeeded = { version: '2.0.55', source: 'path', status: 'restart_needed', proxyVersion: '2.0.0-beta.1', at: 1795278440467 };
  assert.equal(engineSetupOf(restartNeeded, '2.0.55', 'Claude Code').status, 'ready');
});

test('a failure stays current, with its notice, while no Proxy or only an older one answers', () => {
  for (const proxyVersion of [null, '2.0.49', '2.0.0-beta.1']) {
    const setup = engineSetupOf(FAILED_ON_2050, proxyVersion, 'dsh');
    assert.equal(setup.status, 'start_failed', String(proxyVersion));
    assert.match(setup.notice, /Evolver 2\.0\.50 is installed but its Proxy did not start/);
  }
});

test('a Desktop failure is not cured by some other Proxy; a success and a missing setup are shown as they are', () => {
  const desktop = { source: 'desktop', status: 'setup_error', error: 'A different Evolver Proxy is running.', at: 1 };
  assert.equal(engineSetupOf(desktop, '2.0.55', 'Codex').status, 'setup_error');
  assert.deepEqual(engineSetupOf({ version: '2.0.55', source: 'path', status: 'ready', proxyVersion: '2.0.55', at: 1 }, '2.0.55', 'dsh'), {
    status: 'ready', version: '2.0.55', at: '1970-01-01T00:00:00.001Z',
  });
  assert.deepEqual(engineSetupOf(null, '2.0.55', 'dsh'), { status: 'not_run' });
  assert.equal(engineSetupOf({ status: 'outdated', source: 'managed', at: 9e15 }, null, 'dsh').at, null, 'a time past what Date holds is not a time');
});
