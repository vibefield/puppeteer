import { execFile, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  AgentProfileSchema,
  ProfileIdentitySchema,
  type AgentProfile,
  type ProfileFailure,
  type ProfileIdentity,
} from '@vibefield/puppeteer-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HermesWrapperRead } from './distribution.js';
import {
  createHermesProfileService,
  hermesProfileIdentityFrom,
  HERMES_PROFILE_ROOT_VARIABLE,
  type HermesProfileExec,
} from './profiles.js';

const execFileAsync = promisify(execFile);

const service = createHermesProfileService({ home: resolve('/home/tester'), executable: 'hermes' });
const verifiedAt = '2026-09-23T12:00:00.000Z';

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile =>
  AgentProfileSchema.parse({
    id: 'hermes:5b7c31de',
    provider: 'hermes',
    label: 'Research',
    kind: 'managed',
    dataRoot: resolve('/home/tester/.puppeteer/profiles/hermes/5b7c31de'),
    createdAt: new Date().toISOString(),
    ...overrides,
  });

// Wrapper script captured 2026-09-06 from a Hermes 0.20.5 install.
const wrapper = [
  '#!/usr/bin/env bash',
  'unset PYTHONPATH',
  'unset PYTHONHOME',
  'exec "/home/tester/.hermes/hermes-agent/venv/bin/python" "/home/tester/.hermes/hermes-agent/hermes" "$@"',
  '',
].join('\n');

// Credential-shaped values that must never reach an identity.
const TOKENS = [
  'tok_live_nous_ACCESS',
  'rt_live_nous_REFRESH',
  'tok_live_codex_ACCESS',
  'sk-or-v1-SECRET',
  'ghu_SECRET',
];

const identity = (outcome: ProfileIdentity | ProfileFailure): ProfileIdentity => {
  expect(outcome).not.toHaveProperty('status');
  return ProfileIdentitySchema.parse(outcome);
};

const document = (overrides: Record<string, unknown> = {}) => ({
  v: 1,
  nous: { state: 'none' },
  pool: [],
  selected: null,
  ...overrides,
});

const verifying = (stdout: string, overrides: Parameters<typeof createHermesProfileService>[0] = {}) => {
  const exec = vi.fn<HermesProfileExec>(async () => ({ stdout }));
  const readWrapper = vi.fn<HermesWrapperRead>(async () => wrapper);
  const verifier = createHermesProfileService({
    home: resolve('/home/tester'),
    executable: 'hermes',
    env: { PATH: '/usr/bin:/bin', HOME: resolve('/home/tester') },
    now: () => new Date(verifiedAt),
    exec,
    readWrapper,
    ...overrides,
  });
  return { verifier, exec, readWrapper };
};

describe('Hermes profiles', () => {
  it('advertises the native root variable, default root, and the Nous Portal service', () => {
    expect(HERMES_PROFILE_ROOT_VARIABLE).toBe('HERMES_HOME');
    expect(service.provider.support).toMatchObject({
      supported: true,
      identity: 'native-protocol',
      nativeDefaultRoot: resolve('/home/tester/.hermes'),
      credential: 'root',
      service: { id: 'nous', label: 'Nous Research' },
    });
    expect(service.provider.support.sharedSurfaces).toHaveLength(3);
  });

  it('offers the Nous Portal sign-in first and a sign-in to another provider', () => {
    expect(service.provider.support.signInRoutes).toEqual([
      { id: 'portal', label: 'Nous Portal', service: { id: 'nous', label: 'Nous Research' } },
      { id: 'provider', label: 'Another provider…' },
    ]);
  });

  it('binds a managed profile through the native root variable', () => {
    expect(service.bindingEnvironment(profile())).toEqual({
      HERMES_HOME: resolve('/home/tester/.puppeteer/profiles/hermes/5b7c31de'),
    });
  });

  it('injects nothing for the native default profile', () => {
    expect(
      service.bindingEnvironment(profile({ kind: 'native-default', dataRoot: resolve('/home/tester/.hermes') })),
    ).toEqual({});
  });

  it('initializes a root Hermes keeps to itself', async () => {
    await expect(service.initializeRoot?.(profile())).resolves.toBeUndefined();
    await expect(
      service.initializeRoot?.(profile({ dataRoot: resolve('/home/tester/.puppeteer/profiles/work/hermes-5b7c31de') })),
    ).resolves.toBeUndefined();
    await expect(
      service.initializeRoot?.(profile({ kind: 'native-default', dataRoot: resolve('/home/tester/.hermes') })),
    ).resolves.toBeUndefined();
  });

  it("refuses a root Hermes would fold into another root's sign-in", async () => {
    for (const dataRoot of [
      // A parent named `profiles` makes the grandparent Hermes's root.
      resolve('/home/tester/.puppeteer/profiles/profiles/hermes-5b7c31de'),
      // Any home inside ~/.hermes has ~/.hermes as its root.
      resolve('/home/tester/.hermes/profiles/work'),
      resolve('/home/tester/.hermes/puppeteer/hermes-5b7c31de'),
      resolve('/home/tester/.hermes'),
    ]) {
      await expect(service.initializeRoot?.(profile({ dataRoot })), dataRoot).rejects.toThrow(/another root/);
    }
    await expect(
      service.initializeRoot?.(profile({ dataRoot: resolve('/home/tester/.hermes-work/hermes-5b7c31de') })),
    ).resolves.toBeUndefined();
  });

  it('names the history layout root for an indexer', () => {
    expect(service.observationRoot(profile())).toBe(resolve('/home/tester/.puppeteer/profiles/hermes/5b7c31de'));
    expect(
      service.observationRoot(profile({ kind: 'native-default', dataRoot: resolve('/home/tester/.hermes') })),
    ).toBe(resolve('/home/tester/.hermes'));
  });

  it('signs in to Nous Portal with `hermes portal`, never the removed `hermes login`', () => {
    const expected = {
      command: 'hermes',
      args: ['portal'],
      cwd: resolve('/work/repo'),
      env: { HERMES_HOME: resolve('/home/tester/.puppeteer/profiles/hermes/5b7c31de') },
    };
    expect(service.loginInvocation(profile(), { cwd: resolve('/work/repo') })).toEqual(expected);
    expect(service.loginInvocation(profile(), { cwd: resolve('/work/repo'), route: 'portal' })).toEqual(expected);
  });

  it("adds another provider's sign-in through the native credential-pool manager", () => {
    expect(service.loginInvocation(profile(), { cwd: resolve('/work/repo'), route: 'provider' })).toEqual({
      command: 'hermes',
      args: ['auth'],
      cwd: resolve('/work/repo'),
      env: { HERMES_HOME: resolve('/home/tester/.puppeteer/profiles/hermes/5b7c31de') },
    });
  });

  it('refuses a route it never offered', () => {
    expect(() => service.loginInvocation(profile(), { cwd: resolve('/work/repo'), route: 'login' })).toThrow(
      /sign-in route/,
    );
  });
});

describe('Hermes identity read', () => {
  it("runs Hermes's own helpers in the interpreter the wrapper execs, with only HERMES_HOME bound", async () => {
    const { verifier, exec, readWrapper } = verifying(JSON.stringify(document()), {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: resolve('/home/tester'),
        PYTHONPATH: '/elsewhere',
        PYTHONHOME: '/elsewhere',
        HERMES_HOME: resolve('/home/tester/.hermes-other'),
        // a launched session never sees these, and Hermes's pool loader would seed and save them
        NOUS_API_KEY: 'SECRET-nous',
        OPENROUTER_API_KEY: 'SECRET-openrouter',
        GH_TOKEN: 'SECRET-gh',
        AWS_SECRET_ACCESS_KEY: 'SECRET-aws',
      },
    });
    await verifier.verify(profile());

    expect(readWrapper).toHaveBeenCalledWith('hermes', expect.objectContaining({ PATH: '/usr/bin:/bin' }));
    expect(exec).toHaveBeenCalledTimes(1);
    const [file, args, options] = exec.mock.calls[0]!;
    expect(file).toBe('/home/tester/.hermes/hermes-agent/venv/bin/python');
    expect(args.slice(0, 3)).toEqual(['-I', '-B', '-c']);
    expect(args).toHaveLength(4);
    expect(options.env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: resolve('/home/tester'),
      HERMES_HOME: resolve('/home/tester/.puppeteer/profiles/hermes/5b7c31de'),
    });

    const script = args[3]!;
    expect(script).toContain('get_nous_auth_status_local()');
    expect(script).toContain('force_fresh=True');
    expect(script).toContain('read_credential_pool()');
    expect(script).toContain('read_raw_config');
    // The refreshing status call spends the single-use refresh token; the pool
    // loader runs `gh auth token` and writes the pool back.
    expect(script).not.toContain('get_nous_auth_status()');
    expect(script).not.toContain('load_pool(');
  });

  it('reads the native default without a root variable, even one the host inherited', async () => {
    const { verifier, exec } = verifying(JSON.stringify(document()), {
      env: { PATH: '/usr/bin:/bin', HOME: resolve('/home/tester'), HERMES_HOME: resolve('/home/tester/.hermes-other') },
    });
    await verifier.verify(profile({ kind: 'native-default', dataRoot: resolve('/home/tester/.hermes') }));
    expect(exec.mock.calls[0]![2].env).toEqual({ PATH: '/usr/bin:/bin', HOME: resolve('/home/tester') });
  });

  it('prefers an interpreter the composition names', async () => {
    const { verifier, exec, readWrapper } = verifying(JSON.stringify(document()), { python: '/opt/hermes/bin/python' });
    await verifier.verify(profile());
    expect(readWrapper).not.toHaveBeenCalled();
    expect(exec.mock.calls[0]![0]).toBe('/opt/hermes/bin/python');
  });

  it("falls back to HERMES_PYTHON when the command is not Hermes's wrapper", async () => {
    const { verifier, exec } = verifying(JSON.stringify(document()), {
      env: { PATH: '/usr/bin:/bin', HERMES_PYTHON: '/opt/hermes/bin/python3' },
      readWrapper: async () => '#!/bin/sh\nexec /usr/bin/other "$@"\n',
    });
    await verifier.verify(profile());
    expect(exec.mock.calls[0]![0]).toBe('/opt/hermes/bin/python3');
  });

  it('is unavailable, not signed out, when no interpreter can be found', async () => {
    const { verifier, exec } = verifying(JSON.stringify(document()), {
      readWrapper: async () => {
        throw new Error('EACCES');
      },
    });
    await expect(verifier.verify(profile())).resolves.toMatchObject({
      status: 'unavailable',
      provider: 'hermes',
      retryable: true,
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('is unavailable and retryable when the interpreter or its imports fail', async () => {
    const { verifier } = verifying('', {
      exec: async () => {
        throw Object.assign(new Error('Command failed'), { code: 3 });
      },
    });
    await expect(verifier.verify(profile())).resolves.toMatchObject({
      status: 'unavailable',
      provider: 'hermes',
      retryable: true,
    });
  });

  it('is unavailable when the script prints something other than JSON', async () => {
    await expect(verifying('Traceback (most recent call last):').verifier.verify(profile())).resolves.toMatchObject({
      status: 'unavailable',
      retryable: true,
    });
  });

  it('is unavailable for a document it does not recognize, instead of guessing a sign-out', async () => {
    for (const unrecognized of [
      {},
      { loggedIn: false },
      document({ v: 2 }),
      document({ nous: { state: 'signed-out' } }),
      document({ nous: null }),
      document({ pool: {} }),
    ]) {
      await expect(
        verifying(JSON.stringify(unrecognized)).verifier.verify(profile()),
        JSON.stringify(unrecognized),
      ).resolves.toMatchObject({ status: 'unavailable', retryable: true });
    }
  });

  it('reads the last line, past anything Hermes wrote to stdout directly', async () => {
    const stdout = `warning: plugin manifest skipped\n${JSON.stringify(document({ nous: { state: 'free-tier' } }))}\n`;
    const result = identity(await verifying(stdout).verifier.verify(profile()));
    expect(result.signIns).toEqual([{ service: { id: 'nous', label: 'Nous Research' }, method: 'free-tier' }]);
  });
});

describe('Hermes identity document', () => {
  const portal = { id: 'nous', label: 'Nous Research' };

  it('reads a root with no credential as signed out', () => {
    expect(identity(hermesProfileIdentityFrom(document(), verifiedAt))).toEqual({
      loggedIn: false,
      signIns: [],
      verifiedAt,
      source: { kind: 'native-protocol', stability: 'experimental' },
    });
  });

  it('reads the free tier as a sign-in with no account behind it', () => {
    const result = identity(
      hermesProfileIdentityFrom(document({ nous: { state: 'free-tier' }, selected: 'nous' }), verifiedAt),
    );
    expect(result).toMatchObject({ loggedIn: true, method: 'free-tier' });
    expect(result).not.toHaveProperty('email');
    expect(result.signIns).toEqual([{ service: portal, method: 'free-tier', inUse: true }]);
  });

  it('reads the Portal account the root is signed in to, and repeats it when it is in use', () => {
    const result = identity(
      hermesProfileIdentityFrom(
        document({
          nous: { state: 'account', email: 'ada@example.com', organization: 'Analytical Engines', plan: 'Pro' },
          selected: 'nous',
        }),
        verifiedAt,
      ),
    );
    expect(result).toEqual({
      loggedIn: true,
      method: 'oauth',
      email: 'ada@example.com',
      organization: 'Analytical Engines',
      plan: 'Pro',
      signIns: [
        {
          service: portal,
          method: 'oauth',
          subscription: true,
          inUse: true,
          email: 'ada@example.com',
          organization: 'Analytical Engines',
          plan: 'Pro',
        },
      ],
      verifiedAt,
      source: { kind: 'native-protocol', stability: 'experimental' },
    });
  });

  it('keeps a Portal login the portal could not be reached to confirm, without who or which plan', () => {
    const result = identity(
      hermesProfileIdentityFrom(
        // Details beside a state that has none are not the script's and are dropped.
        document({ nous: { state: 'unreachable', email: 'ada@example.com' }, selected: 'nous' }),
        verifiedAt,
      ),
    );
    expect(result).toMatchObject({ loggedIn: true, method: 'oauth' });
    expect(result).not.toHaveProperty('email');
    expect(result.signIns).toEqual([{ service: portal, method: 'oauth', subscription: true, inUse: true }]);
  });

  it('drops a Portal session the portal refused', () => {
    const result = identity(hermesProfileIdentityFrom(document({ nous: { state: 'rejected' } }), verifiedAt));
    expect(result).toMatchObject({ loggedIn: false, signIns: [] });
    const others = identity(
      hermesProfileIdentityFrom(
        document({ nous: { state: 'rejected' }, pool: [{ provider: 'openrouter', authType: 'api_key' }] }),
        verifiedAt,
      ),
    );
    expect(others.signIns).toEqual([{ service: { id: 'openrouter', label: 'OpenRouter' }, method: 'api-key' }]);
  });

  it('lists every sign-in the pool holds, by the service it is billed through', () => {
    const result = identity(
      hermesProfileIdentityFrom(
        document({
          pool: [
            { provider: 'anthropic', authType: 'oauth', borrowed: 'claude_code', name: 'Anthropic' },
            { provider: 'anthropic', authType: 'api_key', name: 'Anthropic' },
            { provider: 'copilot', authType: 'api_key', borrowed: 'gh_cli', name: 'GitHub Copilot' },
            { provider: 'custom:lab-box/v2', authType: 'api_key', name: 'custom:lab-box/v2' },
            { provider: 'deepseek', authType: 'api_key', name: 'DeepSeek' },
            { provider: 'gemini', authType: 'api_key', name: 'Google AI Studio' },
            { provider: 'kimi-coding', authType: 'api_key', name: 'Kimi / Moonshot' },
            { provider: 'nous', authType: 'api_key', name: 'Nous Portal' },
            { provider: 'openai-codex', authType: 'oauth', name: 'OpenAI Codex' },
            { provider: 'opencode-go', authType: 'api_key', name: 'OpenCode Go' },
            { provider: 'openrouter', authType: 'api_key' },
            { provider: 'xai-oauth', authType: 'oauth', name: 'xAI Grok OAuth (SuperGrok / Premium+)' },
          ],
        }),
        verifiedAt,
      ),
    );
    expect(result.loggedIn).toBe(true);
    expect(result).not.toHaveProperty('method');
    expect(result.signIns).toEqual([
      {
        service: { id: 'anthropic', label: 'Anthropic' },
        method: 'claude-code',
        subscription: true,
        borrowedFrom: 'Claude Code',
      },
      { service: { id: 'anthropic', label: 'Anthropic' }, method: 'api-key' },
      // The machine's gh login: every root that loads Copilot shows the same account.
      { service: { id: 'github', label: 'GitHub' }, method: 'gh-cli', borrowedFrom: 'GitHub CLI' },
      // A custom endpoint keeps the name it was given; its pool key is no service id.
      { service: { id: 'custom-lab-box-v2', label: 'lab-box/v2' }, method: 'api-key' },
      { service: { id: 'deepseek', label: 'DeepSeek' }, method: 'api-key' },
      { service: { id: 'google', label: 'Google' }, method: 'api-key' },
      { service: { id: 'kimi', label: 'Moonshot AI' }, method: 'api-key' },
      // An opaque Nous inference key: billed through Nous, but no Portal login.
      { service: portal, method: 'api-key' },
      { service: { id: 'openai', label: 'OpenAI' }, method: 'oauth', subscription: true },
      { service: { id: 'opencode', label: 'OpenCode' }, method: 'api-key' },
      { service: { id: 'openrouter', label: 'OpenRouter' }, method: 'api-key' },
      { service: { id: 'xai', label: 'xAI' }, method: 'oauth', subscription: true },
    ]);
  });

  it('marks the sign-in the configured provider uses, and only that one', () => {
    const result = identity(
      hermesProfileIdentityFrom(
        document({
          nous: { state: 'account', email: 'ada@example.com', plan: 'Pro' },
          pool: [
            { provider: 'openai-codex', authType: 'oauth' },
            { provider: 'openai-codex', authType: 'oauth' },
          ],
          selected: 'openai-codex',
        }),
        verifiedAt,
      ),
    );
    expect(result).toMatchObject({ loggedIn: true, method: 'oauth' });
    // The top level is the in-use sign-in's; the Portal account is not it.
    expect(result).not.toHaveProperty('email');
    expect(result.signIns?.map((signIn) => signIn.inUse ?? false)).toEqual([false, true, false]);
  });

  it('marks nothing when the configured provider holds no sign-in', () => {
    const result = identity(
      hermesProfileIdentityFrom(
        document({ pool: [{ provider: 'openrouter', authType: 'api_key' }], selected: 'anthropic' }),
        verifiedAt,
      ),
    );
    expect(result).toMatchObject({ loggedIn: true });
    expect(result).not.toHaveProperty('method');
    expect(result.signIns?.some((signIn) => signIn.inUse)).toBe(false);
  });

  it('allowlists the document again: nothing credential-shaped survives', () => {
    const result = identity(
      hermesProfileIdentityFrom(
        document({
          nous: {
            state: 'account',
            email: 'ada@example.com',
            access_token: TOKENS[0],
            refresh_token: TOKENS[1],
            raw_account: { token: TOKENS[0] },
          },
          pool: [
            {
              provider: 'openai-codex',
              authType: 'oauth',
              access_token: TOKENS[2],
              label: 'work',
              borrowed: 'device_code',
            },
            { provider: 'openrouter', authType: 'api_key', key: TOKENS[3], name: { token: TOKENS[3] } },
            { provider: 'copilot', authType: 'api_key', borrowed: 'gh_cli', token: TOKENS[4] },
            { provider: ':::', authType: 'api_key' },
            { provider: ' ', authType: 'api_key' },
            { provider: 'openrouter', authType: 7 },
            'openrouter',
          ],
          selected: 'nous',
          token: TOKENS[0],
        }),
        verifiedAt,
      ),
    );
    const serialized = JSON.stringify(result);
    for (const token of TOKENS) expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('work');
    expect(result.signIns).toEqual([
      { service: portal, method: 'oauth', subscription: true, inUse: true, email: 'ada@example.com' },
      // `device_code` is Hermes's own login, not a borrowed one.
      { service: { id: 'openai', label: 'OpenAI' }, method: 'oauth', subscription: true },
      { service: { id: 'openrouter', label: 'OpenRouter' }, method: 'api-key' },
      { service: { id: 'github', label: 'GitHub' }, method: 'gh-cli', borrowedFrom: 'GitHub CLI' },
    ]);
  });

  it('keeps the list within the contract', () => {
    const pool = Array.from({ length: 80 }, () => ({ provider: 'openrouter', authType: 'api_key' }));
    const result = identity(hermesProfileIdentityFrom(document({ pool, selected: 'openrouter' }), verifiedAt));
    expect(result.signIns).toHaveLength(64);
  });
});

/**
 * The script itself, against stand-ins for Hermes's modules in a scratch
 * virtual environment laid out as the installer lays it out. It runs the
 * system `python3`, never Hermes's interpreter, and needs no network.
 */
const python3 = spawnSync('python3', ['-c', 'import venv'], { encoding: 'utf8' }).status === 0;

const STUBS: Record<string, string> = {
  'hermes_cli/__init__.py': '',
  'hermes_cli/_scenario.py': [
    'import json, os',
    'def load():',
    '    with open(os.path.join(os.environ["HERMES_HOME"], "scenario.json")) as handle:',
    '        return json.load(handle)',
  ].join('\n'),
  'hermes_cli/auth.py': [
    'from hermes_cli._scenario import load',
    'calls = {"local": 0}',
    'def get_nous_auth_status_local():',
    '    snapshots = load()["local"]',
    '    calls["local"] += 1',
    '    return snapshots[min(calls["local"], len(snapshots)) - 1]',
    'def get_nous_auth_status():',
    '    raise AssertionError("redeems the refresh token")',
    'def read_credential_pool(provider_id=None):',
    '    return load()["pool"]',
    'def get_auth_provider_display_name(provider_id):',
    '    return load().get("names", {}).get(provider_id, provider_id)',
    'def resolve_provider(requested=None):',
    '    return {"claude": "anthropic"}.get(requested, requested)',
  ].join('\n'),
  'hermes_cli/config.py': [
    'from hermes_cli._scenario import load',
    'def read_raw_config():',
    '    return load().get("config", {})',
    'def load_config():',
    '    raise AssertionError("creates directories and writes a backup")',
  ].join('\n'),
  'hermes_cli/nous_account.py': [
    'from types import SimpleNamespace',
    'from hermes_cli._scenario import load',
    'if load().get("failImport"):',
    '    raise ImportError("stand-in")',
    'def get_nous_portal_account_info(*, force_fresh=False, min_jwt_ttl_seconds=60):',
    '    assert force_fresh, "the account document, not the JWT snapshot"',
    '    account = dict(load()["account"])',
    '    plan = account.pop("subscription", None)',
    '    return SimpleNamespace(subscription=SimpleNamespace(**plan) if plan else None, **account)',
  ].join('\n'),
  'agent/__init__.py': '',
  'agent/credential_pool.py': [
    'from dataclasses import dataclass, field',
    'STATUS_DEAD = "dead"',
    'FIELDS = ("auth_type", "source", "priority", "access_token", "refresh_token", "last_status")',
    '@dataclass',
    'class PooledCredential:',
    '    provider: str',
    '    auth_type: str = "api_key"',
    '    source: str = "manual"',
    '    priority: int = 0',
    '    access_token: str = ""',
    '    refresh_token: object = None',
    '    last_status: object = None',
    '    extra: dict = field(default_factory=dict)',
    '    @classmethod',
    '    def from_dict(cls, provider, payload):',
    '        known = {key: value for key, value in payload.items() if key in FIELDS}',
    '        extra = {key: value for key, value in payload.items() if key not in FIELDS}',
    '        return cls(provider=provider, extra=extra, **known)',
    'def load_pool(provider):',
    '    raise AssertionError("seeds the pool and writes it back")',
  ].join('\n'),
};

// This integration fixture models the installer's POSIX shell wrapper and venv.
describe.skipIf(!python3 || process.platform === 'win32')('Hermes identity script', () => {
  let scratch: string;
  let bin: string;
  const printed: string[] = [];

  const recordingExec: HermesProfileExec = async (file, args, options) => {
    const { stdout } = await execFileAsync(file, [...args], { env: options.env, encoding: 'utf8' });
    printed.push(stdout);
    return { stdout };
  };

  const verifyScenario = async (scenario: Record<string, unknown>, runner: 'recording' | 'default' = 'recording') => {
    const dataRoot = await mkdtemp(join(scratch, 'root-'));
    await writeFile(join(dataRoot, 'scenario.json'), JSON.stringify(scenario));
    const verifier = createHermesProfileService({
      home: join(scratch, 'home'),
      executable: 'hermes',
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: join(scratch, 'home') },
      now: () => new Date(verifiedAt),
      ...(runner === 'recording' ? { exec: recordingExec } : {}),
    });
    return verifier.verify(profile({ dataRoot }));
  };

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'puppeteer-hermes-identity-'));
    const checkout = join(scratch, 'hermes-agent');
    const venv = join(checkout, 'venv');
    await execFileAsync('python3', ['-m', 'venv', '--without-pip', venv]);
    const { stdout } = await execFileAsync(join(venv, 'bin', 'python'), [
      '-c',
      'import sysconfig; print(sysconfig.get_paths()["purelib"])',
    ]);
    const sitePackages = stdout.trim();
    for (const [path, source] of Object.entries(STUBS)) {
      await mkdir(join(sitePackages, path, '..'), { recursive: true });
      await writeFile(join(sitePackages, path), `${source}\n`);
    }
    // The installer's wrapper, found on PATH and read; never executed.
    bin = join(scratch, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'hermes'),
      `#!/usr/bin/env bash\nunset PYTHONPATH\nunset PYTHONHOME\nexec "${venv}/bin/python" "${checkout}/hermes" "$@"\n`,
    );
    await chmod(join(bin, 'hermes'), 0o755);
  }, 60_000);

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it('reads the Portal account and the pool, and prints no token', async () => {
    const result = identity(
      await verifyScenario({
        local: [{ logged_in: true, access_token: TOKENS[0], has_refresh_token: true, free_tier: false }],
        account: {
          logged_in: true,
          source: 'account_api',
          email: 'ada@example.com',
          org_name: 'Analytical Engines',
          subscription: { plan: 'Pro', tier: 2, credits_remaining: 12.5 },
          raw_account: { user: { email: 'ada@example.com' }, token: TOKENS[0] },
          raw_claims: { sub: 'user_1' },
          privy_did: 'did:privy:1',
        },
        pool: {
          nous: [
            { source: 'device_code', auth_type: 'oauth', access_token: TOKENS[0], refresh_token: TOKENS[1] },
            { source: 'manual', auth_type: 'api_key', access_token: TOKENS[0], priority: 1 },
          ],
          'openai-codex': [
            {
              source: 'manual:device_code',
              auth_type: 'oauth',
              access_token: TOKENS[2],
              refresh_token: TOKENS[1],
              label: 'ada@example.com',
            },
          ],
          copilot: [{ source: 'gh_cli', auth_type: 'api_key', label: 'gh auth token', secret_fingerprint: 'sha256:1' }],
          openrouter: [
            { source: 'env:OPENROUTER_API_KEY', auth_type: 'api_key', priority: 0 },
            { source: 'manual', auth_type: 'api_key', access_token: TOKENS[3], last_status: 'dead', priority: 1 },
          ],
        },
        config: { model: { provider: 'nous', default: 'hermes-4' } },
        names: {
          copilot: 'GitHub Copilot',
          nous: 'Nous Portal',
          'openai-codex': 'OpenAI Codex',
          openrouter: 'OpenRouter',
        },
      }),
    );
    expect(result).toMatchObject({
      loggedIn: true,
      method: 'oauth',
      email: 'ada@example.com',
      organization: 'Analytical Engines',
      plan: 'Pro',
    });
    expect(result.signIns).toEqual([
      {
        service: { id: 'nous', label: 'Nous Research' },
        method: 'oauth',
        subscription: true,
        inUse: true,
        email: 'ada@example.com',
        organization: 'Analytical Engines',
        plan: 'Pro',
      },
      { service: { id: 'github', label: 'GitHub' }, method: 'gh-cli', borrowedFrom: 'GitHub CLI' },
      { service: { id: 'nous', label: 'Nous Research' }, method: 'api-key' },
      { service: { id: 'openai', label: 'OpenAI' }, method: 'oauth', subscription: true },
      { service: { id: 'openrouter', label: 'OpenRouter' }, method: 'api-key' },
    ]);
    const stdout = printed.at(-1)!;
    for (const token of TOKENS) expect(stdout).not.toContain(token);
    for (const dropped of ['did:privy', 'user_1', 'sha256:', 'gh auth token', 'credits_remaining']) {
      expect(stdout).not.toContain(dropped);
    }
    for (const token of TOKENS) expect(JSON.stringify(result)).not.toContain(token);
  });

  it('keeps a Portal login whose account call failed on the network', async () => {
    const result = identity(
      await verifyScenario({
        local: [{ logged_in: true }],
        account: {
          logged_in: true,
          source: 'error',
          error: '<urlopen error [Errno 8] nodename nor servname provided>',
        },
        pool: {},
        config: { model: { provider: 'nous' } },
      }),
    );
    expect(result).toMatchObject({ loggedIn: true, method: 'oauth' });
    expect(result.signIns).toEqual([
      { service: { id: 'nous', label: 'Nous Research' }, method: 'oauth', subscription: true, inUse: true },
    ]);
  });

  it('drops a Portal session the account call refused', async () => {
    const result = identity(
      await verifyScenario({
        local: [{ logged_in: true }],
        account: { logged_in: true, source: 'error', error: 'HTTP Error 401: Unauthorized' },
        pool: {},
      }),
    );
    expect(result).toMatchObject({ loggedIn: false, signIns: [] });
  });

  it("drops a Portal session Hermes's own refresh found revoked", async () => {
    const result = identity(
      await verifyScenario({
        local: [{ logged_in: true }, { logged_in: false, relogin_required: true }],
        account: { logged_in: true, source: 'error', error: 'Refresh session has been revoked' },
        pool: {},
      }),
    );
    expect(result).toMatchObject({ loggedIn: false, signIns: [] });
  });

  it('reads the free tier without asking the portal', async () => {
    // A null account makes the stand-in fail if it is ever asked.
    const result = identity(
      await verifyScenario({ local: [{ logged_in: false, free_tier: true }], account: null, pool: {} }),
    );
    expect(result.signIns).toEqual([{ service: { id: 'nous', label: 'Nous Research' }, method: 'free-tier' }]);
  });

  it('reads a root with no credential as signed out through the default runner', async () => {
    const result = identity(
      await verifyScenario(
        { local: [{ logged_in: false }], account: null, pool: {}, config: { model: { provider: 'auto' } } },
        'default',
      ),
    );
    expect(result).toMatchObject({ loggedIn: false, signIns: [] });
  });

  it('is unavailable when Hermes will not import', async () => {
    await expect(
      verifyScenario({ failImport: true, local: [{ logged_in: true }], account: null, pool: {} }),
    ).resolves.toMatchObject({ status: 'unavailable', provider: 'hermes', retryable: true });
  });
});
