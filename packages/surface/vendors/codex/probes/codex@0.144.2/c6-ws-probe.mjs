// Confirm the app-server socket transport is WebSocket: --listen ws://TCP,
// connect with Node's built-in global WebSocket, drive initialize+thread/start.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { isolatedCodex } from '../../census/harness.mjs';

// The executable under review (PUPPETEER_CODEX_BIN), never `codex` on PATH, in a throwaway HOME and
// CODEX_HOME with an allowlisted environment: not the caller's own, possibly signed-in, profile.
const codex = isolatedCodex();
const LOG = new URL('./c6-ws.log', import.meta.url).pathname;
appendFileSync(LOG, '\n==== ' + new Date().toISOString() + ' ====\n');
const log = (...a) => appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');

const PORT = 8791;
const server = spawn(codex.executable, ['app-server', '--listen', `ws://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'], env: codex.env });
server.stdout.on('data', (d) => log('[srv-out]', d.toString().slice(0, 200)));
server.stderr.on('data', (d) => log('[srv-err]', d.toString().slice(0, 200)));
await new Promise((r) => setTimeout(r, 1800));

let nextId = 1;
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const send = (method, params) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }));
const notify = (method, params) => ws.send(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }));

ws.addEventListener('open', () => { log('WS OPEN'); send('initialize', { clientInfo: { name: 'ws', version: '0' }, capabilities: {} }); });
ws.addEventListener('error', (e) => log('WS ERROR', e.message ?? String(e)));
ws.addEventListener('close', (e) => log('WS CLOSE', e.code, e.reason));
let started = false;
ws.addEventListener('message', (ev) => {
  const s = String(ev.data);
  log('WS MSG', s.slice(0, 240));
  let m; try { m = JSON.parse(s); } catch { return; }
  if (m.id === 1 && m.result !== undefined) { notify('initialized'); send('thread/start', { cwd: '/private/tmp', sandbox: 'read-only', approvalPolicy: 'never' }); }
  if (m.id === 2 && m.result?.thread) { started = true; log('THREAD', m.result.thread.id, m.result.thread.sessionId, m.result.thread.path); }
});

await new Promise((r) => setTimeout(r, 5000));
log('started:', started);
try { ws.close(); } catch {}
server.kill('SIGTERM');
setTimeout(() => process.exit(0), 200);
