import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COPILOT_SERVER_ARGS, CopilotServerClient, spawnCopilotServerTransport } from './server-client.js';

/**
 * A stand-in for `copilot --server --stdio`, run by Node from a temp
 * directory: it speaks the same Content-Length JSON-RPC and answers test-only
 * methods about itself. No vendor binary runs in these tests.
 */
const FAKE_SERVER = String.raw`
import { spawn } from 'node:child_process';
if (process.env.FAKE_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => {});
const frame = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'), body]);
};
const answer = (id, result) => process.stdout.write(frame({ jsonrpc: '2.0', id, result }));
let asking;
const handlers = {
  ping: (id) => answer(id, { message: 'pong', protocolVersion: 3 }),
  echo: (id, params) => answer(id, params),
  describe: (id) => answer(id, { pid: process.pid, argv: process.argv.slice(2), env: Object.keys(process.env).sort() }),
  fail: (id) => process.stdout.write(frame({ jsonrpc: '2.0', id, error: { code: -32603, message: 'gho_servererrorsecret' } })),
  'spawn-child': (id) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    answer(id, { pid: child.pid });
  },
  split: (id) => {
    const bytes = frame({ jsonrpc: '2.0', id, result: { text: 'split — 世界' } });
    process.stdout.write(bytes.subarray(0, 30));
    setTimeout(() => process.stdout.write(bytes.subarray(30)), 20);
  },
  ask: (id) => {
    asking = id;
    process.stdout.write(frame({ jsonrpc: '2.0', id: 'server-1', method: 'permission.request', params: {} }));
  },
  garbage: () => process.stdout.write('not a frame\r\n\r\n'),
};
let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString('ascii'))[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
    buffer = buffer.subarray(end + 4 + length);
    if (message.method === undefined && message.id === 'server-1') answer(asking, { reply: message });
    else handlers[message.method]?.(message.id, message.params);
  }
});
`;

const ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/home/tester', FAKE_MARK: '1' };

let directory: string;
let executable: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'copilot-server-'));
  executable = join(directory, 'fake-copilot.mjs');
  await writeFile(executable, FAKE_SERVER, 'utf8');
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function eventually(condition: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return condition();
}

function connect(
  overrides: { env?: Record<string, string>; stopGraceMs?: number; requestTimeoutMs?: number } = {},
): CopilotServerClient {
  const transport = spawnCopilotServerTransport({
    executable,
    env: overrides.env ?? ENV,
    ...(overrides.stopGraceMs !== undefined ? { stopGraceMs: overrides.stopGraceMs } : {}),
  });
  return new CopilotServerClient(transport, { requestTimeoutMs: overrides.requestTimeoutMs ?? 5_000 });
}

describe('Copilot server transport', () => {
  it('starts the server with the SDK flags and exactly the environment it is given', async () => {
    const client = connect();
    try {
      const described = (await client.request('describe')) as { argv: string[]; env: string[] };
      expect(described.argv).toEqual([...COPILOT_SERVER_ARGS]);
      // macOS CoreFoundation sets its text-encoding variable inside the child itself.
      expect(described.env.filter((name) => !name.startsWith('__CF_'))).toEqual(['FAKE_MARK', 'HOME', 'PATH']);
    } finally {
      await client.close();
    }
  });

  it('carries requests and multi-byte answers across real pipes, split frames included', async () => {
    const client = connect();
    try {
      await expect(client.request('ping')).resolves.toMatchObject({ protocolVersion: 3 });
      await expect(client.request('echo', { login: 'octo-dév 🎉' })).resolves.toEqual({ login: 'octo-dév 🎉' });
      await expect(client.request('split')).resolves.toEqual({ text: 'split — 世界' });
    } finally {
      await client.close();
    }
  });

  it('answers a request from the server with method-not-found', async () => {
    const client = connect();
    try {
      await expect(client.request('ask')).resolves.toEqual({
        reply: { jsonrpc: '2.0', id: 'server-1', error: { code: -32601, message: 'method not found' } },
      });
    } finally {
      await client.close();
    }
  });

  it('rejects a JSON-RPC error with its code and without the server text', async () => {
    const client = connect();
    try {
      const error = await client.request('fail').catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('-32603');
      expect((error as Error).message).not.toContain('gho_servererrorsecret');
    } finally {
      await client.close();
    }
  });

  it('times out a request the server never answers', async () => {
    const client = connect({ requestTimeoutMs: 100 });
    try {
      await expect(client.request('never')).rejects.toThrow(/timed out/);
    } finally {
      await client.close();
    }
  });

  it('stops a server whose output is not framed JSON-RPC', async () => {
    const client = connect();
    try {
      const { pid } = (await client.request('describe')) as { pid: number };
      await expect(client.request('garbage')).rejects.toThrow(/closed/);
      expect(await eventually(() => !alive(pid))).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("stops the whole process group on close, the server's own children included", async () => {
    const client = connect();
    const { pid } = (await client.request('describe')) as { pid: number };
    const { pid: grandchild } = (await client.request('spawn-child')) as { pid: number };
    expect(alive(grandchild)).toBe(true);
    await client.close();
    expect(alive(pid)).toBe(false);
    expect(await eventually(() => !alive(grandchild))).toBe(true);
  });

  it('kills a server that ignores SIGTERM once the grace has passed', async () => {
    const client = connect({ env: { ...ENV, FAKE_IGNORE_SIGTERM: '1' }, stopGraceMs: 200 });
    const { pid } = (await client.request('describe')) as { pid: number };
    const started = Date.now();
    await client.close();
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(await eventually(() => !alive(pid))).toBe(true);
  });

  it('fails at once when the executable cannot be started', async () => {
    const transport = spawnCopilotServerTransport({ executable: join(directory, 'missing-copilot'), env: ENV });
    const client = new CopilotServerClient(transport, { requestTimeoutMs: 5_000 });
    await expect(client.request('ping')).rejects.toThrow(/closed/);
    await client.close();
  });
});
