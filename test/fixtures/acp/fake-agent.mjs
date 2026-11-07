import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { writeState } from '../../../lib/runtime/store/file-lock.js';

const home = process.env.HOME;
const config = JSON.parse(readFileSync(join(home, 'fixture.json'), 'utf8'));
const session = 'fixture-session';
let thinkingEffort = 'high';
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const records = join(home, 'records');
mkdirSync(records, { recursive: true });
const receipt = {
  pid: process.pid, home, argv: process.argv.slice(2),
  hasPrivateCredential: process.env.EVOLVER_MODEL_API_KEY === 'fixture-private-api-key-NOT-A-REAL-CREDENTIAL',
  hasAmbientCredential: process.env.AMBIENT_API_KEY !== undefined,
  configContainsCredential: JSON.stringify(config).includes('fixture-private-api-key-NOT-A-REAL-CREDENTIAL'),
};
const saveReceipt = () => {
  const file = process.env.FIXTURE_RECEIPT;
  if (!file) return;
  writeState(file, receipt);
};
saveReceipt();

if (config.mode === 'startup-hang') setInterval(() => {}, 1000);
else createInterface({ input: process.stdin }).on('line', async line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: { protocolVersion: 1 } });
  else if (request.method === 'session/new') send({ id: request.id, result: { sessionId: session, configOptions: [{ id: 'model', options: [{ value: config.alias }] }, { id: 'thinking', options: [{ value: 'off' }, { value: 'high' }] }] } });
  else if (request.method === 'session/set_config_option') {
    if (request.params.configId === 'thinking' && config.mode !== 'ignore-effort') thinkingEffort = request.params.value;
    send({ id: request.id, result: {} });
  }
  else if (request.method === 'session/prompt') {
    receipt.promptStarted = true;
    if (config.mode === 'exit-descendant') {
      process.stderr.write('S 42\nD 0 ok\n'); // Native output is never a trusted job proof.
      receipt.descendantNonce = randomBytes(16).toString('hex');
      receipt.descendantPipe = '\\\\.\\pipe\\evolver-acp-fixture-' + receipt.descendantNonce;
      const source = "const net=require('net');const server=net.createServer(socket=>socket.once('data',data=>{if(data.toString()===process.argv[2])socket.end('stopped',()=>{server.close();process.exit(0);});}));server.listen(process.argv[1],()=>{process.send('ready');process.disconnect();});";
      // Detached avoids libuv's per-parent job; it does not request Win32 job breakaway.
      const descendant = spawn(process.execPath, ['-e', source, receipt.descendantPipe, receipt.descendantNonce], { cwd: dirname(process.execPath), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: true, windowsHide: true });
      receipt.descendantPid = descendant.pid;
      await new Promise((resolve, reject) => { descendant.once('message', resolve); descendant.once('error', reject); descendant.once('exit', () => reject(new Error('Fixture descendant exited before readiness'))); });
      receipt.descendantReady = true;
      descendant.unref();
    }
    if (config.mode === 'hang') {
      const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
      receipt.descendantPid = descendant.pid;
      try { saveReceipt(); } catch (error) { descendant.kill('SIGKILL'); throw error; }
      setInterval(() => {}, 1000); return;
    }
    saveReceipt();
    if (config.mode === 'output-limit') { process.stdout.write('x'.repeat(17 * 1024 * 1024)); return; }
    if (config.mode === 'combined-output-limit') process.stderr.write('x'.repeat(9 * 1024 * 1024));
    if (config.mode === 'client-request') { send({ id: 99, method: 'session/request_permission', params: { sessionId: session } }); return; }
    if (config.mode === 'tool-update') { send({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'tool_call', toolCallId: 'unavailable' } } }); return; }
    const proof = { reason: 'completed', providerFinish: 'completed', model: config.model, alias: config.alias, protocol: config.protocol, thinkingEffort, toolSnapshots: [0], toolCalls: 0 };
    if (config.mode === 'native-error') proof.reason = 'failed';
    if (config.mode === 'missing-provider-finish') delete proof.providerFinish;
    if (config.mode === 'wrong-model') proof.model = 'another-model';
    if (config.mode === 'tools-loaded') proof.toolSnapshots = [0, 1];
    if (config.mode === 'native-tool-call') proof.toolCalls = 1;
    if (config.mode !== 'missing-proof') appendFileSync(join(records, 'wire.jsonl'), JSON.stringify(proof) + (config.mode === 'truncated-proof' ? '' : '\n'));
    const answer = config.mode === 'combined-output-limit' ? 'x'.repeat(8 * 1024 * 1024) : config.answer ?? ('answer: ' + request.params.prompt[0].text);
    send({ method: 'session/update', params: { sessionId: config.mode === 'wrong-session' ? 'another-session' : session, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } } } });
    send({ id: request.id, result: { stopReason: config.mode === 'length-cutoff' ? 'max_tokens' : 'end_turn' } });
    if (config.mode === 'duplicate-response') send({ id: request.id, result: { stopReason: 'end_turn' } });
    if (config.mode === 'nonzero-exit') process.exitCode = 17;
  } else if (request.method === 'session/close') {
    send({ id: request.id, result: {} });
    if (config.mode === 'trailing-frame') process.stdout.write('{');
    if (config.mode === 'late-session') send({ method: 'session/update', params: { sessionId: 'unowned-session', update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' } } });
    if (config.mode === 'late-chunk') send({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late untrusted answer' } } } });
  }
});
