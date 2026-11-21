// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

test('Copilot persistence diagnostics tolerate a closed host stderr pipe and still close after recovery', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'evolver-copilot-diagnostic-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const code = `
    import { randomUUID } from 'node:crypto';
    import { connectCopilot } from ${JSON.stringify(new URL('../../../hosts/copilot/dist/adapter.js', import.meta.url).href)};
    import { memoryPorts, PROMPT } from ${JSON.stringify(new URL('../../app/memory-ports.js', import.meta.url).href)};
    const { ports } = memoryPorts();
    const update = ports.sessions.update;
    ports.sessions.update = async () => { throw new Error('fixture storage refused'); };
    const sessionId = randomUUID(), workingDirectory = process.env.TEST_PROFILE;
    let hooks;
    const attached = await connectCopilot(async registration => {
      hooks = registration.hooks;
      return { sessionId, on: () => () => {} };
    }, { env: { HOME: workingDirectory, USERPROFILE: workingDirectory, COPILOT_HOME: workingDirectory, EVOLVER_AUTO_DISTILL: 'off' }, overrides: ports });
    process.stdin.once('data', async () => {
      await hooks.onUserPromptTransformed({ sessionId, workingDirectory, prompt: PROMPT, transformedPrompt: PROMPT, timestamp: new Date() });
      ports.sessions.update = update;
      await attached.close();
      process.stdout.write('COPILOT_DIAGNOSTIC_CLOSED\\n');
    });
    process.stdout.write('COPILOT_DIAGNOSTIC_READY\\n');
  `;
  const completion = promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], {
    cwd: home, env: { ...process.env, TEST_PROFILE: home }, timeout: 8_000, windowsHide: true,
  });
  let output = '', started = false;
  completion.child.stdout.on('data', (chunk) => {
    output += chunk;
    if (!started && output.includes('COPILOT_DIAGNOSTIC_READY')) {
      started = true;
      completion.child.stderr.destroy();
      completion.child.stdin.end('run');
    }
  });
  const { stdout } = await completion;
  assert.equal(started, true);
  assert.equal(completion.child.stdout.readableEnded, true, 'stdout must close normally before the timeout');
  assert.match(stdout, /COPILOT_DIAGNOSTIC_CLOSED/);
});
