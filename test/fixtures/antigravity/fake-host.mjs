import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Linux names a process by its main thread, which a recent Node renames: the title keeps the name the owner probe reads.
process.title = 'language_server';

// Stands in for Antigravity's language server: runs each hook command it is sent through `sh -c` with the payload
// on stdin, as Antigravity does, and stays up until killed, so the hooks find it as their owner process.
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, command, input } = JSON.parse(line);
  const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.on('exit', (code) => process.stdout.write(`${JSON.stringify({ id, code, output })}\n`));
  child.stdin.end(JSON.stringify(input));
});
setInterval(() => {}, 60_000);
