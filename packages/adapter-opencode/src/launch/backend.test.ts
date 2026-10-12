import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startOpenCodeBackend, type OpenCodeBackend } from './backend.js';
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
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(record)}, JSON.stringify({pid:process.pid, borrowed:!!process.env.MODEL_TEST_API_KEY})); setInterval(()=>{},1000);`,
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
});
