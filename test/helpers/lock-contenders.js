import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function until(check) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for a lock contender');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function lockContenders(t, dir, script, args, cleanupMarkers) {
  const children = [];
  const results = () => Promise.all(children);
  t.after(async () => {
    try {
      for (const name of cleanupMarkers) writeFileSync(join(dir, name), '');
    } finally {
      await results();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return {
    run(role) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args, role], { windowsHide: true });
      let stderr = '';
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 15_000);
      child.stderr.on('data', (data) => { stderr += data; });
      child.on('error', (error) => { stderr += String(error); });
      children.push(new Promise((resolve) => child.on('close', (code) => {
        clearTimeout(watchdog);
        resolve({ code, stderr });
      })));
      return child;
    },
    results,
  };
}
