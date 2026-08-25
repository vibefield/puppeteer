import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { startOpenCodeBackend, type OpenCodeBackend } from './backend.js';
import { OpenCodeClient } from './client.js';
import { createOpenCodeImposterFixture } from './test-support/imposter.js';

const backends = new Set<OpenCodeBackend>();
const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...backends].map((backend) => backend.dispose()));
  backends.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe('OpenCode private backend', () => {
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
