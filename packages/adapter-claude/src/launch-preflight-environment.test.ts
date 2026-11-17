import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultClaudeExec } from './detection.js';
import { prepareClaudeTuiSession, type PrepareClaudeTuiSessionOptions } from './driver.js';

// No program runs: execFile is a double that answers a version and records the options it was handed. The module's
// own shared preflight is replaced by one that refuses at once, so a launch that reaches it stops before anything
// starts.
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
  const out = '2.1.263 (Claude Code)\n';
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
vi.mock('./detection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./detection.js')>()),
  preflightClaudeLaunch: vi.fn(async () => {
    throw new Error("the module's shared preflight ran");
  }),
}));

const NOWHERE = '/nonexistent-tests';
const ENV = { PATH: `${NOWHERE}/bin`, HOME: `${NOWHERE}/home`, LANG: 'C' };
// The third argument is named by the change; until then this type carries it.
const execWith = defaultClaudeExec as unknown as (
  file: string,
  args: string[],
  options: { env: Record<string, string> },
) => Promise<{ stdout: string }>;

// Names and booleans only: a red here can print no environment value. A
// script runner may add its own ELECTRON_RUN_AS_NODE over the planted names; nothing else may ride along.
function envCheck(env: Record<string, string | undefined> | undefined) {
  const planted = Object.keys(ENV) as Array<keyof typeof ENV>;
  const allowed = (name: string): boolean => name in ENV || name === 'ELECTRON_RUN_AS_NODE';
  return {
    handed: env !== undefined,
    planted: env !== undefined && planted.every((name) => env[name] === ENV[name]),
    extra: env === undefined ? 0 : Object.keys(env).filter((name) => !allowed(name)).length,
    canary: env !== undefined && 'HOST_ONLY_CANARY_FOR_TESTS' in env,
  };
}
const CLEAN = { handed: true, planted: true, extra: 0, canary: false };

describe("Claude Code's launch preflight and the environment its runs get", () => {
  afterEach(() => {
    calls.length = 0;
    vi.unstubAllEnvs();
  });

  it('runs the executable with the environment it is handed, and nothing of this process own', async () => {
    vi.stubEnv('HOST_ONLY_CANARY_FOR_TESTS', 'daemon-only');
    await execWith(`${NOWHERE}/bin/claude`, ['--version'], { env: ENV });
    expect(calls.length).toBe(1);
    expect(envCheck(calls[0]?.options?.env)).toEqual(CLEAN);
  });

  it("runs a script under this process's runner with the handed environment beneath the runner's own", async () => {
    vi.stubEnv('HOST_ONLY_CANARY_FOR_TESTS', 'daemon-only');
    await execWith(`${NOWHERE}/bin/claude.js`, ['--version'], { env: ENV }).catch(() => undefined);
    expect(calls.length > 0).toBe(true);
    for (const call of calls) expect(envCheck(call.options?.env)).toEqual(CLEAN);
  });

  it('preflights a briefed launch with the preflight it is handed, not the shared one', async () => {
    const preflight = vi.fn(async () => {
      throw new Error('the handed preflight ran');
    });
    // `preflight` is named by the change; until then the options are cast.
    const options = {
      cwd: `${NOWHERE}/work`,
      executable: `${NOWHERE}/bin/claude`,
      instructions: 'Say hello.',
      automate: vi.fn(),
      preflight,
    } as unknown as PrepareClaudeTuiSessionOptions;
    await expect(prepareClaudeTuiSession(options)).rejects.toThrow('the handed preflight ran');
    expect(preflight).toHaveBeenCalledTimes(1);
  });
});
