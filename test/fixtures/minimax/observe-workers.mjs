import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

// Observe only this fixture's detached workers, so teardown never scans unrelated processes.
const { FAKE_MINIMAX_WORKERS: log, FAKE_MINIMAX_WORKER_ENTRY: entry, FAKE_MINIMAX_NODE: node } = process.env;
const spawn = childProcess.spawn;
childProcess.spawn = function (command, args, ...options) {
  const child = spawn.call(this, command, args, ...options);
  if (command === node && args?.[0] === entry && args?.[1] === 'minimax' && Number.isInteger(child.pid)) {
    try {
      appendFileSync(log, JSON.stringify({ pid: child.pid, startedAt: Date.now() }) + '\n');
    } catch (error) {
      child.kill();
      throw error;
    }
  }
  return child;
};
syncBuiltinESMExports();
