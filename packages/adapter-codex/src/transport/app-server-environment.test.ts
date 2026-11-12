import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentProfile } from '@vibefield/puppeteer-core';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexAccountUsageService } from '../services/account-usage.js';
import { createCodexExtensionService } from '../services/extensions.js';
import { createCodexProfileService } from '../services/profiles.js';
import { spawnAppServerTransport } from './app-server-client.js';

// No program runs. spawn returns a stand-in child that exits at once, so no client ever gets an answer and the
// transport stops it through its own kill(); execFile answers `mcp list` with an empty list. Each records the
// options it was handed.
type Call = {
  file: string;
  args: readonly string[];
  options: { env?: Record<string, string | undefined> } | undefined;
};
type Done = (...a: unknown[]) => void;
const spawned = vi.hoisted(() => [] as Call[]);
const executed = vi.hoisted(() => [] as Call[]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const standIn = () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: undefined,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: (): boolean => {
        if (child.exitCode !== null) return true;
        child.exitCode = 0;
        child.stdout.end();
        child.stderr.end();
        queueMicrotask(() => {
          child.emit('exit', 0, null);
          child.emit('close', 0, null);
        });
        return true;
      },
    });
    queueMicrotask(() => child.kill());
    return child;
  };
  const spawn = vi.fn((file: string, args: readonly string[], options: Call['options']) => {
    spawned.push({ file, args, options });
    return standIn();
  });
  const execFile = vi.fn((file: string, args: readonly string[], options: unknown, callback?: Done) => {
    const done = typeof options === 'function' ? (options as Done) : callback;
    executed.push({ file, args, options: typeof options === 'function' ? undefined : (options as Call['options']) });
    queueMicrotask(() => done?.(null, '[]', ''));
    return {};
  });
  const doubles = { execFile, spawn };
  // Strict: every other member throws by name, so nothing here can start a real program.
  const strict: Record<string, unknown> = Object.fromEntries(
    Object.keys(actual).map((name) => [
      name,
      () => {
        throw new Error(`child_process.${name} is not mocked`);
      },
    ]),
  );
  return { ...strict, ...doubles, default: { ...strict, ...doubles } };
});

const NOWHERE = '/nonexistent-tests';
const EXECUTABLE = `${NOWHERE}/bin/codex`;
const ENV = { PATH: `${NOWHERE}/bin`, HOME: `${NOWHERE}/home`, LANG: 'C' };
// The extension inventory runs only in a Codex root that exists: one empty folder of this test's own.
const root = mkdtempSync(join(tmpdir(), 'codex-env-test-'));
// Said so a run's log can show the folder, and that it is gone after.
console.info(`codex env test root: ${root}`);
const profile = {
  id: 'test-profile',
  provider: 'codex',
  label: 'Test profile',
  kind: 'managed',
  dataRoot: root,
  createdAt: '2026-11-12T00:00:00.000Z',
} as AgentProfile;

// Names and booleans only: a red here can print no environment value. Where a
// profile binds the vendor's own CODEX_* names over the planted ones, those may ride along; nothing else may.
function envCheck(env: Record<string, string | undefined> | undefined, bindingMayAdd: boolean) {
  const planted = Object.keys(ENV) as Array<keyof typeof ENV>;
  const allowed = (name: string): boolean => name in ENV || (bindingMayAdd && name.startsWith('CODEX_'));
  return {
    handed: env !== undefined,
    planted: env !== undefined && planted.every((name) => env[name] === ENV[name]),
    extra: env === undefined ? 0 : Object.keys(env).filter((name) => !allowed(name)).length,
    canary: env !== undefined && 'HOST_ONLY_CANARY_FOR_TESTS' in env,
  };
}
const CLEAN = { handed: true, planted: true, extra: 0, canary: false };

function expectServiceEnvironment(call: Call | undefined): void {
  expect(call !== undefined).toBe(true);
  expect(envCheck(call?.options?.env, true)).toEqual(CLEAN);
}

describe("Codex's app-server and `mcp list` runs", () => {
  afterEach(() => {
    spawned.length = 0;
    executed.length = 0;
    vi.unstubAllEnvs();
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('starts the app-server with exactly the environment it is handed when told not to inherit', async () => {
    vi.stubEnv('HOST_ONLY_CANARY_FOR_TESTS', 'daemon-only');
    // `inheritEnvironment` is named by the change; until then this type carries it.
    const options: Parameters<typeof spawnAppServerTransport>[0] & { inheritEnvironment?: boolean } = {
      executable: EXECUTABLE,
      env: ENV,
      inheritEnvironment: false,
    };
    const transport = spawnAppServerTransport(options);
    await Promise.resolve(transport.close()).catch(() => undefined);
    expect(spawned.length).toBe(1);
    expect(envCheck(spawned[0]?.options?.env, false)).toEqual(CLEAN);
  });

  it("hands a profile's verify the service's environment under its binding", async () => {
    vi.stubEnv('HOST_ONLY_CANARY_FOR_TESTS', 'daemon-only');
    await createCodexProfileService({ executable: EXECUTABLE, env: ENV, home: `${NOWHERE}/home`, requestTimeoutMs: 50 })
      .verify(profile)
      .catch(() => undefined);
    expectServiceEnvironment(spawned.find((call) => call.args.includes('app-server')));
  });

  it("hands the extension inventory's app-server and its `mcp list` the service's environment", async () => {
    vi.stubEnv('HOST_ONLY_CANARY_FOR_TESTS', 'daemon-only');
    await createCodexExtensionService({
      executable: EXECUTABLE,
      env: ENV,
      home: `${NOWHERE}/home`,
      requestTimeoutMs: 50,
    })
      .inventory?.(profile)
      .catch(() => undefined);
    expectServiceEnvironment(spawned.find((call) => call.args.includes('app-server')));
    expectServiceEnvironment(executed.find((call) => call.args.includes('mcp')));
  });

  it("hands the account usage read the service's environment", async () => {
    vi.stubEnv('HOST_ONLY_CANARY_FOR_TESTS', 'daemon-only');
    // `env` is named by the change; until then this type carries it.
    const options: Parameters<typeof createCodexAccountUsageService>[0] & { env?: Record<string, string> } = {
      executable: EXECUTABLE,
      env: ENV,
      requestTimeoutMs: 50,
    };
    await createCodexAccountUsageService(options)
      .fetch({ profile })
      .catch(() => undefined);
    expectServiceEnvironment(spawned.find((call) => call.args.includes('app-server')));
  });
});
