import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLoopbackFetch, loopbackFetch } from '../transport/loopback-fetch.js';
import { createOpenCodeModelService, readOpenCodeProviders } from './models.js';

vi.mock('../transport/loopback-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transport/loopback-fetch.js')>();
  return { ...actual, loopbackFetch: vi.fn(actual.loopbackFetch) };
});

const catalog = { all: [], connected: [], default: {} };

describe('OpenCode provider catalog read', () => {
  let server: Server | undefined;

  afterEach(async () => {
    const running = server;
    server = undefined;
    if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
  });

  async function backend(): Promise<{ origin: string; username: string; password: string; seen: string[] }> {
    const seen: string[] = [];
    server = createServer((request, response) => {
      seen.push(`${request.method} ${request.url} ${request.headers.authorization}`);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(catalog));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server!.address() as AddressInfo;
    return { origin: `http://127.0.0.1:${port}`, username: 'opencode', password: 'secret', seen };
  }

  it('reads /provider through the loopback fetch by default', async () => {
    const target = await backend();
    expect(await readOpenCodeProviders(target, '/work/repo', undefined)).toEqual(catalog);
    expect(vi.mocked(loopbackFetch)).toHaveBeenCalledOnce();
    expect(target.seen).toEqual([
      `GET /provider?directory=%2Fwork%2Frepo Basic ${Buffer.from('opencode:secret').toString('base64')}`,
    ]);
  });

  it("survives a predecessor's stale pooled socket on the reused origin", async () => {
    const target = await backend();
    const pooled = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(
        new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }),
      )
      .mockImplementation((input, init) => fetch(input, init));
    const signal = AbortSignal.timeout(5_000);
    const document = await readOpenCodeProviders(target, '/work/repo', signal, createLoopbackFetch({ pooled }));
    expect(document).toEqual(catalog);
    expect(pooled).toHaveBeenCalledTimes(2);
    expect(pooled.mock.calls[0]?.[1]?.signal).toBe(signal);
    expect(target.seen).toHaveLength(1);
  });
});

describe('OpenCode model discovery release line', () => {
  const roots = new Set<string>();
  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.clear();
  });

  /** A shell fake: `--version` records its password variables and prints `version`; anything else records its argv. */
  function fakeOpenCode(version: string): { executable: string; versionLog: string; serveLog: string; cwd: string } {
    const root = mkdtempSync(join(tmpdir(), 'opencode-models-line-'));
    roots.add(root);
    const executable = join(root, 'opencode');
    const versionLog = join(root, 'version.log');
    const serveLog = join(root, 'serve.log');
    writeFileSync(
      executable,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        `  echo "password=\${OPENCODE_PASSWORD-unset} server=\${OPENCODE_SERVER_PASSWORD-unset}" >> '${versionLog}'`,
        `  echo '${version}'`,
        '  exit 0',
        'fi',
        `echo "$*" >> '${serveLog}'`,
        'exit 1',
        '',
      ].join('\n'),
    );
    chmodSync(executable, 0o755);
    return { executable, versionLog, serveLog, cwd: root };
  }

  it.skipIf(process.platform === 'win32')(
    'refuses a 2.x executable as unsupported before serve runs, and reads its version once without passwords',
    async () => {
      const fake = fakeOpenCode('opencode v2.2.5');
      const service = createOpenCodeModelService({
        executable: fake.executable,
        env: { ...process.env, OPENCODE_PASSWORD: 'inherited', OPENCODE_SERVER_PASSWORD: 'inherited' },
      });
      const result = await service.discover({ cwd: fake.cwd, timeoutMs: 10_000 });
      expect(result).toMatchObject({ provider: 'opencode', status: 'unsupported', code: 'unsupported' });
      expect(existsSync(fake.serveLog)).toBe(false);
      expect(readFileSync(fake.versionLog, 'utf8')).toBe('password=unset server=unset\n');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reads a 1.x version once, scrubbed, and lets the backend start without a second read',
    async () => {
      const fake = fakeOpenCode('1.19.5');
      const service = createOpenCodeModelService({
        executable: fake.executable,
        env: { ...process.env, OPENCODE_PASSWORD: 'inherited', OPENCODE_SERVER_PASSWORD: 'inherited' },
      });
      const result = await service.discover({ cwd: fake.cwd, timeoutMs: 10_000 });
      // The fake's serve exits, so discovery fails after the one version read.
      expect(result).toMatchObject({ provider: 'opencode', status: 'error' });
      expect(readFileSync(fake.versionLog, 'utf8')).toBe('password=unset server=unset\n');
      expect(readFileSync(fake.serveLog, 'utf8')).toBe('serve --hostname 127.0.0.1 --port 0 --pure\n');
    },
  );
});
