import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ARTIFACT_CREDENTIAL_DIRECTORIES,
  attemptConnection,
  callerEndpoints,
  hiddenDirectories,
  proveNetworkSandbox,
  sandboxMode,
} from './sandbox.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Whether this host lets an unprivileged process create user and network namespaces. */
const namespacesAvailable =
  process.platform === 'linux' &&
  spawnSync('unshare', ['--user', '--map-root-user', '--net', '--mount', 'true']).status === 0 &&
  spawnSync('python3', ['-I', '-c', 'pass']).status === 0;

describe('census network sandbox', () => {
  it('defaults to the namespace sandbox on Linux and to none elsewhere', () => {
    expect(sandboxMode(['node', 'harness.mjs'], 'linux')).toBe('netns');
    expect(sandboxMode(['node', 'harness.mjs'], 'darwin')).toBe('none');
    expect(sandboxMode(['node', 'harness.mjs', '--sandbox', 'none'], 'linux')).toBe('none');
    expect(() => sandboxMode(['node', 'harness.mjs', '--sandbox', 'netns'], 'darwin')).toThrow(/Linux/);
    expect(() => sandboxMode(['node', 'harness.mjs', '--sandbox', 'off'], 'linux')).toThrow(/netns or none/);
  });

  it('carries only the host and port of the caller proxies into the namespace', () => {
    expect(
      callerEndpoints({
        HTTPS_PROXY: 'http://user:secret@127.0.0.1:44571/path',
        http_proxy: '127.0.0.1:44571',
        ALL_PROXY: 'https://proxy.internal',
        NO_PROXY: 'localhost',
        OTHER: 'http://10.0.0.1:80',
      }),
    ).toEqual(['127.0.0.1:44571', 'proxy.internal:443']);
  });

  it('never hides a home directory that holds a census input', () => {
    expect(hiddenDirectories({ argv: ['node', join(homedir(), 'claude')], cwd: tmpdir() })).not.toContain(homedir());
    for (const directory of hiddenDirectories({ argv: ['node'], cwd: tmpdir() })) {
      expect([...ARTIFACT_CREDENTIAL_DIRECTORIES, homedir()]).toContain(directory);
    }
  });

  it('reports a refused loopback port with its error code', async () => {
    const server = createServer();
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const { port } = server.address();
    await new Promise((resolveClose) => server.close(() => resolveClose()));
    expect(await attemptConnection(`127.0.0.1:${port}`)).toEqual({
      destination: `127.0.0.1:${port}`,
      outcome: 'refused',
      code: 'ECONNREFUSED',
    });
  });

  it('makes no probe and proves nothing outside the namespace', async () => {
    expect(await proveNetworkSandbox({})).toEqual({ denied: false, proof: { sandbox: 'none' } });
  });

  it.skipIf(!namespacesAvailable)('proves from inside the namespace that only loopback is reachable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pcc-sandbox-test-'));
    temporaryDirectories.push(directory);
    const script = join(directory, 'probe.mjs');
    const sandbox = pathToFileURL(join(import.meta.dirname, 'sandbox.mjs')).href;
    writeFileSync(
      script,
      `import { enterCensusSandbox, proveNetworkSandbox } from ${JSON.stringify(sandbox)};
enterCensusSandbox({ argv: process.argv });
console.log(JSON.stringify({ environment: Object.keys(process.env).sort(), ...(await proveNetworkSandbox()) }));
`,
    );
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:9', PUPPETEER_TEST_SECRET: 'not carried' },
    });
    expect(result.status, result.stderr).toBe(0);
    const { environment, denied, proof } = JSON.parse(result.stdout.trim().split('\n').at(-1));
    expect(environment).not.toContain('PUPPETEER_TEST_SECRET');
    expect(environment).not.toContain('HTTPS_PROXY');
    expect(proof).toMatchObject({ sandbox: 'netns', interfaces: ['lo'], ipv4Routes: 0, loopback: 'connected' });
    expect(proof.callerProxies.length).toBeGreaterThan(0);
    for (const probe of [...proof.callerProxies, ...proof.publicDestinations]) expect(probe.outcome).toBe('refused');
    expect(denied).toBe(true);
  });
});
