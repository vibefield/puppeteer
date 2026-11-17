import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuiltinProviders, type BuiltinProviderOptions } from './providers.js';

// No service method runs a program here. Every adapter's service factories are wrapped to record the options the
// composition hands them; codex's prewarm is replaced by a recorder; execFile is a double and spawn refuses
//.
type Call = {
  file: string;
  args: readonly string[];
  options: { env?: Record<string, string | undefined> } | undefined;
};
type Done = (...a: unknown[]) => void;
const executed = vi.hoisted(() => [] as Call[]);
const seen = vi.hoisted(() => new Map<string, unknown[]>());
// Every `create…Service` an adapter exports is wrapped, not only the table's: a factory the composition starts calling
// later is recorded too, and the guard row below fails until the table names it and it is handed the environment.
const wrap = vi.hoisted(() => (actual: Record<string, unknown>, names: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...actual };
  const factories = Object.keys(actual).filter(
    (name) => /^create[A-Za-z]+Service$/.test(name) && typeof actual[name] === 'function',
  );
  for (const name of new Set([...names, ...factories])) {
    const original = actual[name] as (...args: unknown[]) => unknown;
    out[name] = (...args: unknown[]) => {
      seen.set(name, [...(seen.get(name) ?? []), args[0]]);
      return original(...args);
    };
  }
  return out;
});
const FACTORIES = vi.hoisted(() => ({
  claude: ['Distribution', 'Profile', 'Extension', 'Model', 'AccountUsage'].map((k) => `createClaude${k}Service`),
  codex: ['Distribution', 'Profile', 'Extension', 'Model', 'AccountUsage'].map((k) => `createCodex${k}Service`),
  grok: ['Distribution', 'Profile', 'Extension', 'Model', 'AccountUsage'].map((k) => `createGrok${k}Service`),
  kimi: ['Distribution', 'Profile', 'Extension', 'Model', 'AccountUsage'].map((k) => `createKimi${k}Service`),
  opencode: ['Distribution', 'Profile', 'Extension', 'Model'].map((k) => `createOpenCode${k}Service`),
  hermes: ['Distribution', 'Profile', 'Extension', 'Model'].map((k) => `createHermes${k}Service`),
  antigravity: ['Distribution', 'Profile', 'Extension', 'Model', 'AccountUsage'].map(
    (k) => `createAntigravity${k}Service`,
  ),
  copilot: ['Distribution', 'Profile', 'Model'].map((k) => `createCopilot${k}Service`),
  pi: ['Distribution', 'Profile', 'Extension', 'Model'].map((k) => `createPi${k}Service`),
}));

vi.mock('@vibefield/puppeteer-adapter-claude', async (importOriginal) =>
  wrap(await importOriginal(), [...FACTORIES.claude, 'createClaudeLaunchPreflight']),
);
vi.mock('@vibefield/puppeteer-adapter-codex', async (importOriginal) => ({
  ...wrap(await importOriginal(), FACTORIES.codex),
  prewarmCodex: vi.fn(async (options: unknown) => {
    seen.set('prewarmCodex', [...(seen.get('prewarmCodex') ?? []), options]);
  }),
}));
vi.mock('@vibefield/puppeteer-adapter-grok', async (importOriginal) => wrap(await importOriginal(), FACTORIES.grok));
vi.mock('@vibefield/puppeteer-adapter-kimi', async (importOriginal) => wrap(await importOriginal(), FACTORIES.kimi));
vi.mock('@vibefield/puppeteer-adapter-opencode', async (importOriginal) =>
  wrap(await importOriginal(), FACTORIES.opencode),
);
vi.mock('@vibefield/puppeteer-adapter-hermes', async (importOriginal) =>
  wrap(await importOriginal(), FACTORIES.hermes),
);
vi.mock('@vibefield/puppeteer-adapter-antigravity', async (importOriginal) =>
  wrap(await importOriginal(), FACTORIES.antigravity),
);
vi.mock('@vibefield/puppeteer-adapter-copilot', async (importOriginal) =>
  wrap(await importOriginal(), FACTORIES.copilot),
);
vi.mock('@vibefield/puppeteer-adapter-pi', async (importOriginal) => wrap(await importOriginal(), FACTORIES.pi));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const out = '2.1.263 (Claude Code)\n';
  const execFile = vi.fn((file: string, args: readonly string[], options: unknown, callback?: Done) => {
    const done = typeof options === 'function' ? (options as Done) : callback;
    executed.push({ file, args, options: typeof options === 'function' ? undefined : (options as Call['options']) });
    queueMicrotask(() => done?.(null, out, ''));
    return {};
  });
  Object.assign(execFile, {
    [promisify.custom]: (file: string, args: readonly string[], options: Call['options']) => {
      executed.push({ file, args, options });
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
const AGENTS = ['claude', 'codex', 'grok', 'kimi', 'opencode', 'hermes', 'antigravity', 'copilot', 'pi'] as const;

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
type WithEnv =
  | {
      env?: Record<string, string | undefined>;
      ambient?: Record<string, string | undefined>;
      inheritEnvironment?: unknown;
    }
  | undefined;
// The option each factory takes the environment by: `env`, but for grok's usage, whose `env` goes over what its
// `ambient` gives the probe (a named list drawn from it), so the environment is its `ambient`.
const environmentOf = (name: string, options: WithEnv) =>
  name === 'createGrokAccountUsageService' ? options?.ambient : options?.env;
const FACTORY_NAME = /^create[A-Za-z]+Service$/;

function compose() {
  seen.clear();
  const options: BuiltinProviderOptions = {
    executables: Object.fromEntries(AGENTS.map((agent) => [agent, `${NOWHERE}/bin/${agent}`])),
    home: `${NOWHERE}/home`,
    serviceEnvironment: ENV,
  };
  return createBuiltinProviders(options);
}

describe('the environment the built-in providers hand every service', () => {
  afterEach(() => {
    executed.length = 0;
    seen.clear();
  });

  it.each(Object.entries(FACTORIES))("hands every %s service factory the host's environment", (_agent, names) => {
    compose();
    for (const name of names) {
      const handed = seen.get(name) ?? [];
      expect(handed.length, `${name} was not called`).toBeGreaterThan(0);
      for (const options of handed) expect(envCheck(environmentOf(name, options as WithEnv)), name).toEqual(CLEAN);
    }
  });

  it('calls no service factory the table does not name, so a new one cannot miss the environment', () => {
    compose();
    const called = [...seen.keys()].filter((name) => FACTORY_NAME.test(name)).sort();
    const table = Object.values(FACTORIES).flat().sort();
    // Factory names only: a red here prints the names, never an environment.
    expect(called.filter((name) => !table.includes(name))).toEqual([]);
    expect(table.filter((name) => !called.includes(name))).toEqual([]);
    expect(table.length).toBe(40);
  });

  it("builds Claude Code's launch preflight on an exec that runs with the host's environment", async () => {
    compose();
    const handed = seen.get('createClaudeLaunchPreflight') ?? [];
    expect(handed.length).toBe(1);
    const exec = handed[0] as (file: string, args: string[]) => Promise<{ stdout: string }>;
    await exec(`${NOWHERE}/bin/claude`, ['--version']);
    expect(executed.length).toBe(1);
    expect(envCheck(executed[0]?.options?.env)).toEqual(CLEAN);
  });

  it("prewarms Codex with the host's environment, not inheriting this process's own", async () => {
    const codex = compose().find((provider) => provider.descriptor.id === 'codex');
    await codex?.prewarm?.({ signal: new AbortController().signal });
    const handed = (seen.get('prewarmCodex') ?? []) as WithEnv[];
    expect(handed.length).toBe(1);
    expect(envCheck(handed[0]?.env)).toEqual(CLEAN);
    expect(handed[0]?.inheritEnvironment === false).toBe(true);
  });
});
