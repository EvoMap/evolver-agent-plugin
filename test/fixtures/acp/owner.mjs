import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { modelRunnerOf } from '../../../lib/runtime/model-executor.js';
import { declarationFor } from './declaration.mjs';

if (process.argv[5] === 'kill-guardian') {
  const fork = childProcess.fork;
  childProcess.fork = (...args) => {
    const guardian = fork(...args);
    process.once('message', message => { if (message === 'kill-guardian') guardian.kill('SIGKILL'); });
    return guardian;
  };
  syncBuiltinESMExports();
}
const runner = modelRunnerOf(declarationFor(process.argv[2], process.argv[3], process.argv[4] ?? 'hang'), process.env);
try { await runner.complete(runner.capture({ alias: 'route-a' }), 'disposable fixture'); }
catch { process.exitCode = 1; }
