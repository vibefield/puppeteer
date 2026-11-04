import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPENCODE_1_BACKEND_LAUNCH,
  openCodeBackendArguments,
  openCodeReadinessOrigin,
  OpenCodeUnsupportedReleaseLineError,
  startOpenCodeBackend,
  type OpenCodeBackend,
} from './backend.js';
import { OpenCodeClient } from '../transport/client.js';
import { createOpenCodeImposterFixture } from '../test-support/imposter.js';

const backends = new Set<OpenCodeBackend>();
const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...backends].map((backend) => backend.dispose()));
  backends.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
  vi.unstubAllEnvs();
});

describe('OpenCode private backend', () => {
  it('honors a complete environment and cancels a startup that never announces readiness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opencode-model-start-'));
    roots.add(root);
    const executable = join(root, 'waiting.mjs');
    const record = join(root, 'environment.json');
    writeFileSync(
      executable,
      `if (process.argv[2] === '--version') { console.log('1.19.5'); process.exit(0); }
       import('node:fs').then(({writeFileSync}) => writeFileSync(${JSON.stringify(record)}, JSON.stringify({pid:process.pid, borrowed:!!process.env.MODEL_TEST_API_KEY}))); setInterval(()=>{},1000);`,
    );
    vi.stubEnv('MODEL_TEST_API_KEY', 'host-secret');
    const controller = new AbortController();
    const pending = startOpenCodeBackend({ executable, env: {}, inheritEnvironment: false, signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(JSON.parse(readFileSync(record, 'utf8')).borrowed).toBe(false));
    const pid = JSON.parse(readFileSync(record, 'utf8')).pid;
    controller.abort();
    await rejection;
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('finishes cleanly when the executable does not exist', async () => {
    await expect(startOpenCodeBackend({ executable: '/missing-opencode-agent' })).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('uses environment-only auth, reports readiness, and cleans up its owned process', async () => {
    const fixture = createOpenCodeImposterFixture();
    roots.add(fixture.root);
    const backend = await startOpenCodeBackend({
      executable: fixture.executable,
      env: fixture.env,
      startupTimeoutMs: 5_000,
    });
    backends.add(backend);
    expect(backend.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(backend.password.length).toBeGreaterThan(32);
    expect(backend.running()).toBe(true);

    const unauthorized = new OpenCodeClient({
      origin: backend.origin,
      directory: fixture.cwd,
      username: backend.username,
      password: 'wrong',
    });
    await expect(unauthorized.getStatuses()).rejects.toMatchObject({ status: 401 });

    const client = new OpenCodeClient({
      origin: backend.origin,
      directory: fixture.cwd,
      username: backend.username,
      password: backend.password,
    });
    const session = await client.createSession({ title: 'adapter backend test' });
    expect(session.directory).toBe(fixture.cwd);

    await backend.dispose();
    await backend.dispose();
    expect(backend.running()).toBe(false);
  });

  it('refuses non-loopback exposure before spawning', async () => {
    await expect(startOpenCodeBackend({ hostname: '0.0.0.0' })).rejects.toThrow('must bind loopback');
  });

  /**
   * A fake 1.x server: `--version` prints `version`; any other argv records its argv and password variables, then
   * prints `ready` and stays up. Each `--version` read is appended to `versions`.
   */
  function recordingServer(
    ready: string,
    version = '1.19.5',
  ): { executable: string; record: string; versions: string } {
    const root = mkdtempSync(join(tmpdir(), 'opencode-backend-spec-'));
    roots.add(root);
    const executable = join(root, 'server.mjs');
    const record = join(root, 'record.json');
    const versions = join(root, 'versions.log');
    writeFileSync(
      executable,
      `import {appendFileSync, writeFileSync} from 'node:fs';
       if (process.argv[2] === '--version') {
         appendFileSync(${JSON.stringify(versions)}, JSON.stringify({
           password: process.env.OPENCODE_PASSWORD ?? null,
           serverPassword: process.env.OPENCODE_SERVER_PASSWORD ?? null,
         }) + '\\n');
         console.log(${JSON.stringify(version)});
         process.exit(0);
       }
       writeFileSync(${JSON.stringify(record)}, JSON.stringify({
         argv: process.argv.slice(2),
         password: process.env.OPENCODE_PASSWORD ?? null,
         serverPassword: process.env.OPENCODE_SERVER_PASSWORD ?? null,
         username: process.env.OPENCODE_SERVER_USERNAME ?? null,
       }));
       console.log(${JSON.stringify(ready)});
       setInterval(() => {}, 1000);`,
    );
    return { executable, record, versions };
  }

  const versionReads = (versions: string): Array<{ password: string | null; serverPassword: string | null }> => {
    try {
      return readFileSync(versions, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { password: string | null; serverPassword: string | null });
    } catch {
      return [];
    }
  };

  it('keeps the 1.x argv and readiness line as the default launch', async () => {
    expect(openCodeBackendArguments(OPENCODE_1_BACKEND_LAUNCH, '127.0.0.1')).toEqual([
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '0',
      '--pure',
    ]);
    const server = recordingServer('opencode server listening on http://127.0.0.1:45678');
    const backend = await startOpenCodeBackend({ executable: server.executable, startupTimeoutMs: 5_000 });
    backends.add(backend);
    expect(backend.origin).toBe('http://127.0.0.1:45678');
    // The 1.x launch reads `--version` once, before `serve`.
    expect(versionReads(server.versions)).toHaveLength(1);
    expect(JSON.parse(readFileSync(server.record, 'utf8')).argv).toEqual([
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '0',
      '--pure',
    ]);
  });

  it('takes the readiness prefix and flag set as inputs', async () => {
    const launch = {
      command: ['serve'],
      hostnameFlag: '--hostname',
      portFlag: '--port',
      additional: [],
      readyPrefix: 'server listening on ',
    };
    expect(
      openCodeReadinessOrigin('server listening on http://127.0.0.1:4100', '127.0.0.1', 'server listening on '),
    ).toBe('http://127.0.0.1:4100');
    // The 1.x prefix is not a substring match of another line's readiness.
    expect(openCodeReadinessOrigin('server listening on http://127.0.0.1:4100', '127.0.0.1')).toBeUndefined();
    expect(openCodeReadinessOrigin('server listening on http://10.0.0.2:4100', '127.0.0.1', launch.readyPrefix)).toBe(
      undefined,
    );

    const server = recordingServer('server listening on http://127.0.0.1:45679');
    const backend = await startOpenCodeBackend({ executable: server.executable, launch, startupTimeoutMs: 5_000 });
    backends.add(backend);
    expect(backend.origin).toBe('http://127.0.0.1:45679');
    // Another line's launch spec is not refused by the 1.x guard, so it reads no version.
    expect(versionReads(server.versions)).toEqual([]);
    expect(JSON.parse(readFileSync(server.record, 'utf8')).argv).toEqual([
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '0',
    ]);
  });

  it('hands the server its own password only, never one it inherited or was given', async () => {
    vi.stubEnv('OPENCODE_PASSWORD', 'inherited-password');
    vi.stubEnv('OPENCODE_SERVER_PASSWORD', 'inherited-password');
    const server = recordingServer('opencode server listening on http://127.0.0.1:45680');
    const backend = await startOpenCodeBackend({
      executable: server.executable,
      env: { OPENCODE_PASSWORD: 'caller-password' },
      startupTimeoutMs: 5_000,
    });
    backends.add(backend);
    expect(JSON.parse(readFileSync(server.record, 'utf8'))).toMatchObject({
      password: null,
      serverPassword: backend.password,
      username: 'opencode',
    });
    // The version read never sees an inherited or given password either.
    expect(versionReads(server.versions)).toEqual([{ password: null, serverPassword: null }]);
  });

  it('refuses an OpenCode 2.x executable from --version alone, before serve can open the store', async () => {
    // 2.2.5 prints `opencode v2.2.5`, and its real `serve` rejects `--pure` (exit 1, "Unrecognized flag: --pure in
    // command opencode serve", before any opencode.db exists; probe 2026-11-04 in an isolated home). The guard is
    // defense in depth against a later 2.x that accepts the flag, which this fixture models: it starts and announces
    // 2.x readiness, so the refusal must not depend on the start failing.
    const server = recordingServer('server listening on http://127.0.0.1:45681', 'opencode v2.2.5');
    const started = Date.now();
    const failure = await startOpenCodeBackend({ executable: server.executable, startupTimeoutMs: 5_000 }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(OpenCodeUnsupportedReleaseLineError);
    expect(failure).toMatchObject({ code: 'OPENCODE_UNSUPPORTED_RELEASE_LINE', line: '2.x', version: '2.2.5' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(versionReads(server.versions)).toHaveLength(1);
    expect(() => readFileSync(server.record, 'utf8')).toThrow();
  });

  it('refuses 2.x the way 2.2.5 really behaves, rejecting --pure, with the typed error and no serve', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opencode-backend-v2-'));
    roots.add(root);
    const serves = join(root, 'serves.log');
    const real = join(root, 'opencode-2.2.5.mjs');
    writeFileSync(
      real,
      `import {appendFileSync} from 'node:fs';
       if (process.argv[2] === '--version') console.log('opencode v2.2.5');
       else { appendFileSync(${JSON.stringify(serves)}, 'serve\\n'); process.exit(process.argv.includes('--pure') ? 1 : 0); }`,
    );
    await expect(startOpenCodeBackend({ executable: real, startupTimeoutMs: 5_000 })).rejects.toBeInstanceOf(
      OpenCodeUnsupportedReleaseLineError,
    );
    expect(() => readFileSync(serves, 'utf8')).toThrow();
  });

  it('keeps a supported start failure as its own error with no second version read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opencode-backend-v1-'));
    roots.add(root);
    const versions = join(root, 'versions.log');
    const broken = join(root, 'broken-v1.mjs');
    writeFileSync(
      broken,
      `import {appendFileSync} from 'node:fs';
       if (process.argv[2] === '--version') { appendFileSync(${JSON.stringify(versions)}, 'v\\n'); console.log('1.19.5'); }
       else process.exit(3);`,
    );
    await expect(startOpenCodeBackend({ executable: broken, startupTimeoutMs: 5_000 })).rejects.toThrow(
      'stopped before readiness (exit 3)',
    );
    // One read, before the start; the failure itself spawns nothing more.
    expect(readFileSync(versions, 'utf8')).toBe('v\n');
  });

  it('skips the version read when the caller has already read it', async () => {
    const server = recordingServer('opencode server listening on http://127.0.0.1:45682');
    const backend = await startOpenCodeBackend({
      executable: server.executable,
      startupTimeoutMs: 5_000,
      checkReleaseLine: false,
    });
    backends.add(backend);
    expect(versionReads(server.versions)).toEqual([]);
  });
});
