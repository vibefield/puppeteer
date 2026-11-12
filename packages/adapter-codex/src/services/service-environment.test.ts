import type { InstallCandidate } from '@vibefield/puppeteer-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexDistributionService } from './distribution.js';

// No program runs: execFile is a double that answers a version and records the options it was handed.
type Call = {
  file: string;
  args: readonly string[];
  options: { env?: Record<string, string | undefined> } | undefined;
};
type Done = (...a: unknown[]) => void;
const calls = vi.hoisted(() => [] as Call[]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const out = 'codex-cli 0.162.1\n';
  const execFile = vi.fn((file: string, args: readonly string[], options: unknown, callback?: Done) => {
    const done = typeof options === 'function' ? (options as Done) : callback;
    calls.push({ file, args, options: typeof options === 'function' ? undefined : (options as Call['options']) });
    queueMicrotask(() => done?.(null, out, ''));
    return {};
  });
  Object.assign(execFile, {
    [promisify.custom]: (file: string, args: readonly string[], options: Call['options']) => {
      calls.push({ file, args, options });
      return Promise.resolve({ stdout: out, stderr: '' });
    },
  });
  const spawn = vi.fn(() => {
    throw new Error('no spawn is expected here');
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
const ENV = { PATH: `${NOWHERE}/bin`, HOME: `${NOWHERE}/home`, LANG: 'C' };

// Names and booleans only: a red here can print no environment value.
function envCheck(env: Record<string, string | undefined> | undefined) {
  const planted = Object.keys(ENV) as Array<keyof typeof ENV>;
  return {
    handed: env !== undefined,
    planted: env !== undefined && planted.every((name) => env[name] === ENV[name]),
    extra: env === undefined ? 0 : Object.keys(env).filter((name) => !(name in ENV)).length,
    canary: env !== undefined && 'HOST_ONLY_CANARY_FOR_TESTS' in env,
  };
}
const CLEAN = { handed: true, planted: true, extra: 0, canary: false };
const candidate: InstallCandidate = {
  executable: `${NOWHERE}/home/.local/bin/codex`,
  realPath: `${NOWHERE}/home/.local/bin/codex`,
  origin: 'path',
};

describe("a Codex install's version run", () => {
  afterEach(() => {
    calls.length = 0;
    vi.unstubAllEnvs();
  });

  it("is handed the service's environment, and nothing of this process's own", async () => {
    vi.stubEnv('HOST_ONLY_CANARY_FOR_TESTS', 'daemon-only');
    await createCodexDistributionService({ env: ENV }).inspect(candidate);
    const run = calls.find((call) => call.file === candidate.executable);
    expect(run).toBeDefined();
    expect(envCheck(run?.options?.env)).toEqual(CLEAN);
  });
});
