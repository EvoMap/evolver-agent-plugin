const registry = process.env.EVOLVER_TEST_WAITER_REGISTRY;
if (registry && /[\\/]bin[\\/]worker\.mjs$/.test(process.argv[1] ?? '')
  && process.argv[3]?.startsWith('--at=') && (await import('node:worker_threads')).isMainThread) {
  const { existsSync, renameSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const record = join(registry, String(process.pid));
  try {
    writeFileSync(record, JSON.stringify({ pid: process.pid, startedAt: Math.round(Date.now() - process.uptime() * 1000) }));
    renameSync(record, record + '.json');
  } catch (error) {
    if (error.code === 'ENOENT') process.exit(0);
    throw error;
  }
  // Teardown removes the marker before scanning. A registration it missed must exit before running the worker.
  if (!existsSync(join(registry, '.open'))) process.exit(0);
}
