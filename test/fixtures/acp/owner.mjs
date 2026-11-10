import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
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
const declaration = declarationFor(process.argv[2], process.argv[3], process.argv[4] ?? 'hang');
if (process.argv[5] === 'exit-before-fork') {
  declaration.args = (_snapshot, { home }) => {
    writeFileSync(process.argv[3], home);
    process.exit(17);
  };
}
const runner = modelRunnerOf(declaration, process.env);
try { await runner.complete(runner.capture({ alias: 'route-a' }), 'disposable fixture'); }
catch { process.exitCode = 1; }
