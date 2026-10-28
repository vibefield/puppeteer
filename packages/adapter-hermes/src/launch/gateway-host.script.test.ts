/**
 * The gateway host script itself. The admission rule needs only the system
 * `python3`; the served host also needs an interpreter with FastAPI and
 * uvicorn (Hermes's own, through HERMES_PYTHON) and runs against a stand-in
 * `tui_gateway`, never Hermes's.
 */

import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorizedGatewayUrl } from '../transport/gateway-auth.js';
import { eventType, HermesJsonRpcClient, type HermesGatewayFrame } from '../transport/jsonrpc.js';
import { resolveHermesPython, startHermesGatewayHost } from './gateway-host.js';

const execFileAsync = promisify(execFile);
const HOST_SCRIPT = fileURLToPath(new URL('../../scripts/tui-gateway-host.py', import.meta.url));

const python3 = spawnSync('python3', ['-c', 'import hmac'], { encoding: 'utf8' }).status === 0;
const hostPython = resolveHermesPython();
const servesWebSockets =
  process.platform !== 'win32' &&
  spawnSync(hostPython, ['-c', 'import fastapi, uvicorn'], { encoding: 'utf8' }).status === 0;

/** Loads the script as a module (its `main` never runs) and prints each verdict. */
const ADMISSION_PROBE = `
import importlib.util, io, json, sys
spec = importlib.util.spec_from_file_location("tui_gateway_host", sys.argv[1])
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
token = "launch-token"
def read(text):
    try:
        return host.read_gateway_token(io.StringIO(text))
    except RuntimeError as error:
        return "refused: " + str(error)
print(json.dumps({
    "admitted": host.refusal(None, token, token),
    "missing": host.refusal(None, None, token),
    "empty": host.refusal(None, "", token),
    "wrong": host.refusal(None, "launch-tokem", token),
    "prefix": host.refusal(None, "launch", token),
    "browser": host.refusal("http://localhost:5173", token, token),
    "opaque": host.refusal("null", token, token),
    "file": host.refusal("file://", token, token),
    "browserWithoutToken": host.refusal("http://localhost:5173", None, token),
    "read": read("launch-token\\n"),
    "readNothing": read(""),
    "readBlank": read("\\n"),
}))
`;

describe.skipIf(!python3)('Hermes gateway host admission', () => {
  it('admits the launch bearer without an Origin and refuses everything else', async () => {
    const { stdout } = await execFileAsync('python3', ['-I', '-c', ADMISSION_PROBE, HOST_SCRIPT]);
    const noToken = 'refused: Hermes gateway host needs its token on stdin';
    expect(JSON.parse(stdout)).toEqual({
      admitted: null,
      missing: 4401,
      empty: 4401,
      wrong: 4401,
      prefix: 4401,
      browser: 4403,
      opaque: 4403,
      file: 4403,
      browserWithoutToken: 4401,
      read: 'launch-token',
      readNothing: noToken,
      readBlank: noToken,
    });
  });

  it('refuses to start, before it imports anything, when stdin carries no token', () => {
    const result = spawnSync('python3', ['-I', HOST_SCRIPT], { input: '', encoding: 'utf8', timeout: 30_000 });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('"error": "Hermes gateway host needs its token on stdin"');
  });
});

const STAND_IN: Record<string, string> = {
  'tui_gateway/__init__.py': '',
  'tui_gateway/server.py': [
    'import threading',
    '_live_transports_lock = threading.Lock()',
    '_live_transports = []',
    'def _ok(rid, result):',
    '    return {"jsonrpc": "2.0", "id": rid, "result": result}',
    'def _load_cfg():',
    '    return {}',
    '_methods = {"wake.start": lambda rid, params: _ok(rid, {"started": True})}',
  ].join('\n'),
  'tui_gateway/ws.py': [
    'import json',
    'class WSTransport:',
    '    def write(self, frame):',
    '        return True',
    'async def handle_ws(websocket):',
    '    await websocket.accept()',
    '    ready = {"type": "gateway.ready", "payload": {"stand_in": True}}',
    '    await websocket.send_text(json.dumps({"jsonrpc": "2.0", "method": "event", "params": ready}) + "\\n")',
    '    try:',
    '        while True:',
    '            await websocket.receive_text()',
    '    except Exception:',
    '        return',
  ].join('\n'),
};

/** The HTTP status a WebSocket upgrade gets: 101 when admitted, 403 when refused before the accept. */
function upgradeStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      agent: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    request.once('upgrade', (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    request.once('response', (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once('error', reject);
    request.end();
  });
}

describe.skipIf(!servesWebSockets)('Hermes gateway host (the real script, a stand-in tui_gateway)', () => {
  let scratch: string;

  const start = () =>
    startHermesGatewayHost({
      python: hostPython,
      hermesHome: join(scratch, 'home'),
      cwd: scratch,
      env: { PYTHONPATH: join(scratch, 'stand-in') },
    });

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'puppeteer-hermes-gateway-host-'));
    for (const [path, source] of Object.entries(STAND_IN)) {
      await mkdir(join(scratch, 'stand-in', dirname(path)), { recursive: true });
      await writeFile(join(scratch, 'stand-in', path), `${source}\n`);
    }
  });

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it('admits only its own launch bearer, and no browser', async () => {
    const [host, other] = await Promise.all([start(), start()]);
    try {
      expect(host.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/api\/ws$/);
      expect(host.token).not.toBe(other.token);
      const admitted = authorizedGatewayUrl(host.url, host.token);
      expect(await upgradeStatus(admitted)).toBe(101);
      expect(await upgradeStatus(host.url)).toBe(403);
      expect(await upgradeStatus(authorizedGatewayUrl(host.url, ''))).toBe(403);
      expect(await upgradeStatus(authorizedGatewayUrl(host.url, `${host.token}x`))).toBe(403);
      expect(await upgradeStatus(authorizedGatewayUrl(host.url, other.token))).toBe(403);
      expect(await upgradeStatus(admitted, { Origin: 'http://localhost:5173' })).toBe(403);
      expect(await upgradeStatus(admitted, { Origin: 'null' })).toBe(403);
    } finally {
      await Promise.all([host.close(), other.close()]);
    }
  }, 60_000);

  it("serves the adapter's own client", async () => {
    const host = await start();
    const client = new HermesJsonRpcClient(host.url, { token: host.token });
    try {
      const first = new Promise<HermesGatewayFrame>((resolve) => {
        const off = client.onFrame((frame) => {
          off();
          resolve(frame);
        });
      });
      await client.connect();
      const frame = await first;
      expect(eventType(frame)).toBe('gateway.ready');
      expect(frame.params?.payload).toEqual({ stand_in: true });
    } finally {
      await client.close();
      await host.close();
    }
  }, 60_000);
});
