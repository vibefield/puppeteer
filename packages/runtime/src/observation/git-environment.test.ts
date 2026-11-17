import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveGitState } from './git.js';

// git is never run: execFile is a double that answers each observer command from a table and records the argv and
// the options it was handed.
type Call = {
  file: string;
  args: readonly string[];
  options: { env?: Record<string, string | undefined> } | undefined;
};
const calls = vi.hoisted(() => [] as Call[]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const answer = (args: readonly string[]): string => {
    const sub = args[args.indexOf('-C') + 2];
    if (sub === 'symbolic-ref') return args.includes('--short') ? 'main\n' : 'refs/heads/main\n';
    if (args.includes('--verify')) return '0123456789abcdef0123456789abcdef01234567\n';
    if (args.includes('--show-toplevel')) return '/nonexistent-tests/repo\n/nonexistent-tests/repo/.git\n.git\n';
    return '.git\n.git\n.git/HEAD\n.git/packed-refs\n.git/refs/heads/main\n';
  };
  const execFile = vi.fn();
  Object.assign(execFile, {
    [promisify.custom]: (file: string, args: readonly string[], options: Call['options']) => {
      calls.push({ file, args, options });
      return Promise.resolve({ stdout: answer(args), stderr: '' });
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

const CWD = '/nonexistent-tests/repo';
const ENV = { PATH: '/nonexistent-tests/bin', HOME: '/nonexistent-tests/home', LANG: 'C' };
const resolveWith = resolveGitState as (
  cwd: string,
  env?: Record<string, string>,
) => ReturnType<typeof resolveGitState>;

// Names and booleans only: a red here can print no environment value. git's
// own two keys are planted too; nothing else may ride along.
const PLANTED: Record<string, string> = { ...ENV, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
function envCheck(env: Record<string, string | undefined> | undefined) {
  return {
    handed: env !== undefined,
    planted: env !== undefined && Object.keys(PLANTED).every((name) => env[name] === PLANTED[name]),
    extra: env === undefined ? 0 : Object.keys(env).filter((name) => !(name in PLANTED)).length,
    canary: env !== undefined && 'HOST_ONLY_CANARY_FOR_TESTS' in env,
  };
}
const CLEAN = { handed: true, planted: true, extra: 0, canary: false };

describe("the runtime's git observer and what git is handed", () => {
  afterEach(() => {
    calls.length = 0;
    vi.unstubAllEnvs();
  });

  it("hands git the host's environment, with no optional locks and no prompt, and nothing of this process's own", async () => {
    vi.stubEnv('HOST_ONLY_CANARY_FOR_TESTS', 'daemon-only');
    await resolveWith(CWD, ENV);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.file).toBe('git');
      expect(envCheck(call.options?.env)).toEqual(CLEAN);
    }
  });

  it("tells every invocation to run no fsmonitor, no hook and no pager, whatever the repository's config says", async () => {
    await resolveWith(CWD, ENV);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.args.slice(0, 7)).toEqual([
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '--no-pager',
        '-C',
        CWD,
      ]);
    }
  });
});
