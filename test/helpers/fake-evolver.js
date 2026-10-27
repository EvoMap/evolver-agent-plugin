import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A managed engine whose `evolver login` prints the device prompt, waits for an `approved` (or `denied`) file in
// `dir`, then answers as Evolver 2.0.46 does; with a token kept from an earlier approval it answers at once. Each
// start is logged to `<dir>/starts`, with its pid.
const LOGIN = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_EVOLVER_DIR;
fs.appendFileSync(path.join(dir, 'starts'), process.pid + ' ' + process.argv.slice(2).join(' ') + '\n');
if (process.argv[2] !== 'login') process.exit(2);
if (fs.existsSync(path.join(dir, 'token'))) {
  process.stdout.write('\n✓ Logged in to https://hub.test. Token stored at ' + path.join(dir, 'token') + ' (expires 2026-10-27T08:11:34.470Z).\n');
  process.exit(0);
}
setTimeout(() => {
  process.stderr.write('login failed: device_flow_timeout\n');
  process.exit(1);
}, 60000);
process.stdout.write('\nTo authorize this device:\n  1. open  https://hub.test/device?user_code=FAKE-CODE\n  2. enter code:  FAKE-CODE\n\nWaiting for approval (Ctrl-C to cancel)...\n');
const timer = setInterval(() => {
  if (fs.existsSync(path.join(dir, 'denied'))) {
    process.stderr.write('login failed: token poll failed (HTTP 400): access_denied\n');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(dir, 'approved'))) return;
  clearInterval(timer);
  fs.writeFileSync(path.join(dir, 'token'), 'stored');
  process.stdout.write('\n✓ Logged in to https://hub.test. Token stored at ' + path.join(dir, 'token') + ' (expires 2026-10-27T08:11:34.470Z).\n');
  process.exit(0);
}, 50);
`;

/** Installs the fake engine where the plugin's engine setup would put Evolver: `<prefix>/node_modules/@evomap/evolver`. */
export function installFakeEvolver(prefix, dir) {
  const packageDir = join(prefix, 'node_modules', '@evomap', 'evolver');
  mkdirSync(join(packageDir, 'bin'), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@evomap/evolver', version: '2.0.46', bin: { evolver: 'bin/evolver.js' } }));
  writeFileSync(join(packageDir, 'bin', 'evolver.js'), LOGIN);
  return { env: { FAKE_EVOLVER_DIR: dir } };
}
