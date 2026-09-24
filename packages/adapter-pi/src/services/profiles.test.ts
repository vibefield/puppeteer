import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentProfileSchema,
  ProfileIdentitySchema,
  ProfileProviderSchema,
  SignInServiceSchema,
  type AgentProfile,
} from '@vibecook/puppeteer-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizePiNativeInvocation } from '../launch/native-invocation.js';
import { resolvePiAgentDir } from '../observation/session-store.js';
import {
  createPiProfileService,
  piAgentDir,
  piProfileIdentityFrom,
  piSelectedCredential,
  piSignInService,
  piStoredCredentialsFrom,
  PI_PROFILE_ROOT_VARIABLE,
} from './profiles.js';

const service = createPiProfileService({ home: '/home/tester', executable: 'pi' });

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile =>
  AgentProfileSchema.parse({
    id: 'pi:9a3d21ff',
    provider: 'pi',
    label: 'Personal',
    kind: 'managed',
    dataRoot: '/home/tester/.puppeteer/profiles/pi/9a3d21ff',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

describe('Pi profiles', () => {
  it('advertises a native-status identity with no service or sign-in routes of its own', () => {
    expect(() => ProfileProviderSchema.parse(service.provider)).not.toThrow();
    expect(service.provider.support.nativeDefaultRoot).toBe('/home/tester/.pi/agent');
    expect(service.provider.support).toMatchObject({ supported: true, identity: 'native-status', credential: 'root' });
    // A harness: every sign-in is to another company's service, all through `/login`.
    expect(service.provider.support.service).toBeUndefined();
    expect(service.provider.support.signInRoutes).toBeUndefined();
    expect(service.signOut).toBeUndefined();
  });

  it('binds a managed profile one agent level inside the profile root', () => {
    expect(piAgentDir(profile())).toBe('/home/tester/.puppeteer/profiles/pi/9a3d21ff/agent');
    expect(service.bindingEnvironment(profile())).toEqual({
      [PI_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/pi/9a3d21ff/agent',
    });
  });

  it('injects nothing for the native default profile', () => {
    expect(service.bindingEnvironment(profile({ kind: 'native-default', dataRoot: '/home/tester/.pi/agent' }))).toEqual(
      {},
    );
  });

  it('names the profile root as the history layout root, the parent of the bound agent directory', () => {
    // Pi's transcripts are <root>/agent/sessions/<cwd>/<id>.jsonl, so an
    // indexer applies the layout to the profile root, and to ~/.pi natively.
    expect(service.observationRoot(profile())).toBe('/home/tester/.puppeteer/profiles/pi/9a3d21ff');
    expect(service.observationRoot(profile({ kind: 'native-default', dataRoot: '/home/tester/.pi/agent' }))).toBe(
      '/home/tester/.pi',
    );
  });

  it('opens the agent itself bound to the profile because Pi has no login command', () => {
    const spec = service.loginInvocation(profile(), { cwd: '/work/repo' });
    expect(spec).toEqual({
      command: 'pi',
      args: [],
      cwd: '/work/repo',
      env: { [PI_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/pi/9a3d21ff/agent' },
    });
    // `pi auth print-api-key` and `print-bearer-token` emit credentials and are
    // never invoked by the host.
    expect(spec.args.join(' ')).not.toContain('auth');
  });

  it('produces a binding the adapter turns into the agent directory its observation reads', () => {
    // The composition root normalizes bindingEnvironment through the adapter's
    // own invocation normalizer, and the session store resolves the same
    // variable, so the bound agent directory must stay one level inside the
    // observation root.
    const binding = service.bindingEnvironment(profile());
    const resolution = normalizePiNativeInvocation({
      providerId: 'pi',
      cwd: '/work/repo',
      argv: [],
      environment: binding,
      implementation: { kind: 'native' },
    });
    expect(resolution).toEqual({
      status: 'accepted',
      options: { piAgentDir: '/home/tester/.puppeteer/profiles/pi/9a3d21ff/agent' },
    });
    expect(resolvePiAgentDir(binding[PI_PROFILE_ROOT_VARIABLE])).toBe(
      join(service.observationRoot(profile()), 'agent'),
    );
  });
});

// Every secret below carries SECRET, so one substring check proves none escaped.
const OAUTH = { type: 'oauth', access: 'at-SECRET-access', refresh: 'rt-SECRET-refresh', expires: 1_900_000_000_000 };
const API_KEY = { type: 'api_key', key: 'sk-SECRET-key', env: { CLOUDFLARE_ACCOUNT_ID: 'acct-SECRET-env' } };
const NOW = new Date('2026-09-23T12:00:00.000Z');
const SOURCE = { kind: 'native-status', stability: 'experimental' } as const;

/** The host's own environment: provider credentials a stored-nothing root must never be credited with. */
const AMBIENT = {
  PATH: '/usr/bin',
  HOME: '/Users/test',
  XAI_API_KEY: 'xai-SECRET-ambient',
  ANTHROPIC_OAUTH_TOKEN: 'sk-ant-oat-SECRET-ambient',
  COPILOT_GITHUB_TOKEN: 'gho-SECRET-ambient',
  AWS_PROFILE: 'work',
  AWS_SECRET_ACCESS_KEY: 'aws-SECRET-ambient',
  GOOGLE_APPLICATION_CREDENTIALS: '/Users/test/adc.json',
  [PI_PROFILE_ROOT_VARIABLE]: '/Users/test/elsewhere',
};

interface Call {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

const ready = (provider: string, authType: string): string => JSON.stringify({ status: 'ready', provider, authType });

describe('Pi profile verification', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'pi-profiles-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const managed = (): AgentProfile => profile({ dataRoot: join(home, 'profiles', 'pi-9a3d21ff') });
  const nativeDefault = (): AgentProfile =>
    profile({ id: 'pi:native-default', kind: 'native-default', dataRoot: join(home, '.pi', 'agent') });

  /** Lay down a root; a string is written verbatim, anything else as JSON. */
  async function root(agentDir: string, auth?: unknown, settings?: unknown): Promise<void> {
    await mkdir(agentDir, { recursive: true });
    const body = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));
    if (auth !== undefined) await writeFile(join(agentDir, 'auth.json'), body(auth));
    if (settings !== undefined) await writeFile(join(agentDir, 'settings.json'), body(settings));
  }

  /** `respond` is the check's stdout, or throws to stand in for a run that failed or exited non-zero. */
  function verifier(respond: string | (() => string), calls: Call[] = []): ReturnType<typeof createPiProfileService> {
    return createPiProfileService({
      home,
      executable: '/usr/local/bin/pi',
      env: AMBIENT,
      now: () => NOW,
      exec: async (file, args, options) => {
        calls.push({ file, args, env: options.env });
        return { stdout: typeof respond === 'string' ? respond : respond() };
      },
    });
  }

  it('never counts an ambient key: a root that stores nothing is signed out, and Pi is not asked', async () => {
    const calls: Call[] = [];
    const pi = verifier(ready('xai', 'api_key'), calls);
    const signedOut = { loggedIn: false, signIns: [], verifiedAt: NOW.toISOString(), source: SOURCE };
    // no directory yet, an empty store, and an empty file, which Pi's own store reads as empty
    expect(await pi.verify(managed())).toEqual(signedOut);
    await root(piAgentDir(managed()), {});
    expect(await pi.verify(managed())).toEqual(signedOut);
    await root(piAgentDir(managed()), '');
    expect(await pi.verify(managed())).toEqual(signedOut);
    expect(calls).toEqual([]);
  });

  it('reads files Pi wrote with a byte-order mark, as Pi itself does', async () => {
    const bom = String.fromCharCode(0xfeff);
    await root(
      piAgentDir(managed()),
      `${bom}${JSON.stringify({ xai: OAUTH })}`,
      `${bom}${JSON.stringify({ defaultProvider: 'xai' })}`,
    );
    expect(await verifier(ready('xai', 'oauth')).verify(managed())).toMatchObject({
      loggedIn: true,
      method: 'oauth',
      signIns: [{ service: { id: 'xai' }, inUse: true }],
    });
  });

  it('lists every stored sign-in and marks the saved default in use once Pi confirms it', async () => {
    const agentDir = piAgentDir(managed());
    await root(agentDir, { anthropic: API_KEY, xai: OAUTH }, { defaultProvider: 'xai', defaultModel: 'grok-4.6' });
    const calls: Call[] = [];
    const identity = await verifier(ready('xai', 'oauth'), calls).verify(managed());
    expect(identity).toEqual({
      loggedIn: true,
      method: 'oauth',
      signIns: [
        { service: { id: 'anthropic', label: 'Anthropic' }, method: 'api-key' },
        { service: { id: 'xai', label: 'xAI' }, method: 'oauth', subscription: true, inUse: true },
      ],
      verifiedAt: NOW.toISOString(),
      source: SOURCE,
    });
    expect(() => ProfileIdentitySchema.parse(identity)).not.toThrow();
    // one read-only check, for the selected provider only, bound to the root and
    // with every ambient provider credential removed
    expect(calls).toEqual([
      {
        file: '/usr/local/bin/pi',
        args: ['auth', 'check', '--provider', 'xai', '--json', '--no-refresh'],
        env: { PATH: '/usr/bin', HOME: '/Users/test', [PI_PROFILE_ROOT_VARIABLE]: agentDir },
      },
    ]);
    expect(JSON.stringify([identity, calls])).not.toContain('SECRET');
  });

  it('accepts only the stored credential type, so an ambient key never stands in for a stored login', async () => {
    await root(piAgentDir(managed()), { xai: OAUTH }, { defaultProvider: 'xai' });
    const unconfirmed = {
      loggedIn: true,
      signIns: [{ service: { id: 'xai', label: 'xAI' }, method: 'oauth', subscription: true }],
      verifiedAt: NOW.toISOString(),
      source: SOURCE,
    };
    expect(await verifier(ready('xai', 'api_key')).verify(managed())).toEqual(unconfirmed);
    // an answer about some other provider confirms nothing either
    expect(await verifier(ready('anthropic', 'oauth')).verify(managed())).toEqual(unconfirmed);
  });

  it('keeps a sign-in the check does not confirm listed, only not in use: a failed check is no sign-out', async () => {
    await root(piAgentDir(managed()), { anthropic: OAUTH }, { defaultProvider: 'anthropic' });
    const responses: Array<string | (() => string)> = [
      JSON.stringify({ status: 'not_ready', provider: 'anthropic', reason: 'provider_not_found' }),
      JSON.stringify({ status: 'invalid', provider: 'anthropic', reason: 'invalid_state' }),
      'ready',
      '',
      () => {
        throw Object.assign(new Error('Command failed: exit 1'), { stdout: '{"status":"not_ready"}' });
      },
      () => {
        throw new Error('spawn /usr/local/bin/pi ENOENT');
      },
    ];
    for (const respond of responses) {
      expect(await verifier(respond).verify(managed())).toEqual({
        loggedIn: true,
        signIns: [{ service: { id: 'anthropic', label: 'Anthropic' }, method: 'oauth', subscription: true }],
        verifiedAt: NOW.toISOString(),
        source: SOURCE,
      });
    }
  });

  it('falls back to the only subscription login, then the first stored, when the default is not stored', async () => {
    const stored = piStoredCredentialsFrom({ openrouter: OAUTH, anthropic: API_KEY, 'kimi-coding': OAUTH }) ?? [];
    expect(piSelectedCredential(stored, 'anthropic')?.providerId).toBe('anthropic');
    // the saved default is an ambient-key provider this root does not store
    expect(piSelectedCredential(stored, 'openai')?.providerId).toBe('kimi-coding');
    expect(piSelectedCredential(stored, undefined)?.providerId).toBe('kimi-coding');
    // two subscriptions, or none (an Anthropic API key and OpenRouter's OAuth are not one): the first stored
    const two = piStoredCredentialsFrom({ anthropic: OAUTH, xai: OAUTH }) ?? [];
    expect(piSelectedCredential(two, undefined)?.providerId).toBe('anthropic');
    const none = piStoredCredentialsFrom({ openrouter: OAUTH, anthropic: API_KEY }) ?? [];
    expect(piSelectedCredential(none, undefined)?.providerId).toBe('openrouter');
    expect(piSelectedCredential([], 'xai')).toBeUndefined();

    // A settings file Pi itself could not read names no default either.
    await root(piAgentDir(managed()), { anthropic: API_KEY, 'kimi-coding': OAUTH }, '{"defaultProvider": ');
    const calls: Call[] = [];
    const identity = await verifier(ready('kimi-coding', 'oauth'), calls).verify(managed());
    expect(calls.map((call) => call.args[3])).toEqual(['kimi-coding']);
    expect(identity).toMatchObject({
      method: 'oauth',
      signIns: [
        { service: { id: 'anthropic' }, method: 'api-key' },
        { service: { id: 'kimi', label: 'Moonshot AI' }, method: 'oauth', subscription: true, inUse: true },
      ],
    });
  });

  it('refuses to describe an auth.json it cannot read, without quoting it', async () => {
    const agentDir = piAgentDir(managed());
    const calls: Call[] = [];
    const pi = verifier(ready('xai', 'oauth'), calls);
    const unreadable = [
      '{"xai": {"type": "oauth", "access": "at-SECRET-access"',
      '[]',
      { xai: 'at-SECRET-access' },
      { xai: { access: 'at-SECRET-access' } },
      { xai: { type: 'OAuth Token', access: 'at-SECRET-access' } },
    ];
    for (const auth of unreadable) {
      await root(agentDir, auth);
      const failure = await pi.verify(managed());
      expect(failure).toMatchObject({ status: 'unavailable', provider: 'pi', retryable: true });
      expect(JSON.stringify(failure)).not.toContain('SECRET');
    }
    // a store that cannot be read at all
    await rm(join(agentDir, 'auth.json'));
    await mkdir(join(agentDir, 'auth.json'));
    expect(await pi.verify(managed())).toMatchObject({ status: 'unavailable', provider: 'pi', retryable: true });
    expect(calls).toEqual([]);
  });

  it("binds the native default's check to ~/.pi/agent, never to a root variable the host inherited", async () => {
    const agentDir = join(home, '.pi', 'agent');
    await root(agentDir, { 'github-copilot': OAUTH }, { defaultProvider: 'github-copilot' });
    const calls: Call[] = [];
    const identity = await verifier(ready('github-copilot', 'oauth'), calls).verify(nativeDefault());
    expect(calls[0]?.env[PI_PROFILE_ROOT_VARIABLE]).toBe(agentDir);
    expect(identity).toMatchObject({
      loggedIn: true,
      signIns: [{ service: { id: 'github', label: 'GitHub' }, method: 'oauth', subscription: true, inUse: true }],
    });
  });

  it('never passes a provider id that Pi would read as a flag', async () => {
    await root(piAgentDir(managed()), { '--credentials': OAUTH }, { defaultProvider: '--credentials' });
    const calls: Call[] = [];
    const identity = await verifier(ready('--credentials', 'oauth'), calls).verify(managed());
    expect(calls).toEqual([]);
    expect(identity).toMatchObject({ loggedIn: true, signIns: [{ method: 'oauth' }] });
    expect(() => ProfileIdentitySchema.parse(identity)).not.toThrow();
  });
});

describe('Pi credential projection', () => {
  it('keeps the provider id, the type and the two non-secret extras, and nothing else', () => {
    const stored = piStoredCredentialsFrom({
      'openai-codex': { ...OAUTH, accountId: 'acct-7' },
      'github-copilot': { ...OAUTH, enterpriseUrl: 'example.ghe.com', availableModelIds: ['gpt-5.4'] },
      anthropic: API_KEY,
    });
    expect(stored).toEqual([
      { providerId: 'openai-codex', type: 'oauth', accountId: 'acct-7' },
      { providerId: 'github-copilot', type: 'oauth', enterpriseUrl: 'example.ghe.com' },
      { providerId: 'anthropic', type: 'api_key' },
    ]);
    expect(JSON.stringify(stored)).not.toContain('SECRET');
  });

  it('never turns the ChatGPT account id into an email or account handle', () => {
    const stored = piStoredCredentialsFrom({ 'openai-codex': { ...OAUTH, accountId: 'acct-7' } }) ?? [];
    const identity = piProfileIdentityFrom(stored, 'openai-codex', NOW.toISOString());
    expect(identity).toEqual({
      loggedIn: true,
      method: 'oauth',
      signIns: [{ service: { id: 'openai', label: 'OpenAI' }, method: 'oauth', subscription: true, inUse: true }],
      verifiedAt: NOW.toISOString(),
      source: SOURCE,
    });
    expect(JSON.stringify(identity)).not.toContain('acct-7');
  });

  it('maps Pi providers onto the shared services and passes the rest through', () => {
    expect(piSignInService('openai-codex')).toEqual({ id: 'openai', label: 'OpenAI' });
    expect(piSignInService('openai')).toEqual({ id: 'openai', label: 'OpenAI' });
    expect(piSignInService('github-copilot')).toEqual({ id: 'github', label: 'GitHub' });
    expect(piSignInService('kimi-coding')).toEqual({ id: 'kimi', label: 'Moonshot AI' });
    expect(piSignInService('meta')).toEqual({ id: 'meta', label: 'Meta' });
    expect(piSignInService('openrouter')).toEqual({ id: 'openrouter', label: 'OpenRouter' });
    expect(piSignInService('groq')).toEqual({ id: 'groq', label: 'groq' });
    // a custom provider's own name, folded into the shared id alphabet
    expect(piSignInService('LM Studio')).toEqual({ id: 'lm-studio', label: 'LM Studio' });
    for (const providerId of [
      'anthropic',
      'xai',
      'llama.cpp',
      'LM Studio',
      '本地模型',
      '--credentials',
      'x'.repeat(90),
    ]) {
      expect(() => SignInServiceSchema.parse(piSignInService(providerId))).not.toThrow();
    }
    expect(piSignInService('本地模型')).toMatchObject({ label: '本地模型' });
  });
});
