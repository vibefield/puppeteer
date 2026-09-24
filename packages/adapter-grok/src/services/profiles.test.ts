import {
  AgentProfileSchema,
  ProfileIdentitySchema,
  ProfileProviderSchema,
  type AgentProfile,
} from '@vibecook/puppeteer-core';
import { describe, expect, it } from 'vitest';
import {
  createGrokProfileService,
  GROK_PROFILE_ROOT_VARIABLE,
  grokProfileIdentityFrom,
  type GrokProfileServiceOptions,
} from './profiles.js';
import type { GrokAgentTransport } from '../transport/agent-client.js';

const HOME = '/home/tester';
const NOW = new Date('2026-09-23T12:00:00.000Z');
/** Absolute and nonexistent: a probe that missed its fake fails to spawn instead of reaching an install. */
const EXECUTABLE = '/opt/grok-test/bin/grok';
const SOURCE = { kind: 'native-protocol', stability: 'experimental' } as const;

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile =>
  AgentProfileSchema.parse({
    id: 'grok:8c8c0a1e',
    provider: 'grok',
    label: 'Work',
    kind: 'managed',
    dataRoot: '/home/tester/.puppeteer/profiles/grok/8c8c0a1e',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

const managed = profile();
const nativeDefault = profile({ id: 'grok:native-default', kind: 'native-default', dataRoot: '/home/tester/.grok' });

/** `_x.ai/auth/info` as Grok 1.0.41 answered it on 2026-09-23, with the account's values replaced. */
const SIGNED_IN_INFO = {
  methodId: 'cached_token',
  email: 'dev@example.com',
  firstName: 'Dev',
  lastName: null,
  profileImageUrl: 'grok-asset://users/7f3c9a/avatar',
  teamId: 'team-5d1e',
  teamName: null,
  teamRole: null,
  organizationId: null,
  organizationName: null,
  organizationRole: null,
  principalType: 'User',
  principalId: 'user-7f3c9a',
  userBlockedReason: null,
  teamBlockedReasons: [],
  codingDataRetentionOptOut: false,
};

/** An empty `GROK_HOME`: no method, no account; the retention flag is only the no-credential default. */
const SIGNED_OUT_INFO = {
  ...SIGNED_IN_INFO,
  methodId: null,
  email: null,
  firstName: null,
  profileImageUrl: null,
  teamId: null,
  principalType: null,
  principalId: null,
  codingDataRetentionOptOut: true,
};

const BILLING = {
  config: { creditUsagePercent: 3, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' } },
  subscription_tier: 'SuperGrok Heavy',
};

const AUTH_REQUIRED = { error: { code: -32_000, message: 'Authentication required' } };

type Reply = { result: unknown } | { error: { code: number; message: string } } | 'silent';

/** A scripted `grok agent`: answers by method (-32601 for any other) and records its spawns and requests. */
function fakeAgent(replies: Record<string, Reply>) {
  const spawns: Array<{ executable: string; env: NodeJS.ProcessEnv }> = [];
  const sent: Array<Record<string, unknown>> = [];
  let isClosed = false;
  return {
    spawns,
    sent,
    methods: () => sent.map((message) => message.method),
    closed: () => isClosed,
    spawnTransport(options: { executable: string; env: NodeJS.ProcessEnv }): GrokAgentTransport {
      spawns.push(options);
      let onMessage: ((message: unknown) => void) | undefined;
      return {
        send(message) {
          const request = message as Record<string, unknown>;
          sent.push(request);
          if (request.id === undefined) return;
          const reply = replies[String(request.method)] ?? { error: { code: -32_601, message: 'Method not found' } };
          if (reply === 'silent') return;
          queueMicrotask(() => onMessage?.({ jsonrpc: '2.0', id: request.id, ...reply }));
        },
        onMessage(handler) {
          onMessage = handler;
        },
        onClose() {},
        close() {
          isClosed = true;
        },
      };
    },
  };
}

const signedIn = (info: unknown = SIGNED_IN_INFO, billing: Reply = { result: BILLING }) =>
  fakeAgent({
    initialize: { result: { protocolVersion: 1, authMethods: [{ id: 'cached_token' }] } },
    '_x.ai/auth/info': { result: info },
    '_x.ai/billing': billing,
  });

function service(
  agent: ReturnType<typeof fakeAgent>,
  overrides: GrokProfileServiceOptions = {},
): ReturnType<typeof createGrokProfileService> {
  return createGrokProfileService({
    executable: EXECUTABLE,
    home: HOME,
    env: { PATH: '/usr/bin:/bin', HOME },
    now: () => NOW,
    spawnTransport: agent.spawnTransport,
    ...overrides,
  });
}

describe('Grok profiles', () => {
  it('declares xAI sign-ins read over the native protocol and kept inside the root', () => {
    const { provider } = service(signedIn());
    expect(() => ProfileProviderSchema.parse(provider)).not.toThrow();
    expect(provider).toEqual({
      id: 'grok',
      label: 'Grok',
      support: {
        supported: true,
        identity: 'native-protocol',
        sharedSurfaces: [],
        nativeDefaultRoot: '/home/tester/.grok',
        credential: 'root',
        service: { id: 'xai', label: 'xAI' },
      },
    });
    expect(service(signedIn()).signOut).toBeUndefined();
  });

  it('binds a managed profile through the native root variable', () => {
    expect(service(signedIn()).bindingEnvironment(managed)).toEqual({
      [GROK_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/grok/8c8c0a1e',
    });
  });

  it('injects nothing for the native default profile', () => {
    expect(service(signedIn()).bindingEnvironment(nativeDefault)).toEqual({});
  });

  it('names the history layout root for an indexer', () => {
    const profiles = service(signedIn());
    expect(profiles.observationRoot(managed)).toBe('/home/tester/.puppeteer/profiles/grok/8c8c0a1e');
    expect(profiles.observationRoot(nativeDefault)).toBe('/home/tester/.grok');
  });

  it('runs the native interactive login inside the profile binding', () => {
    expect(service(signedIn()).loginInvocation(managed, { cwd: '/work/repo' })).toEqual({
      command: EXECUTABLE,
      args: ['login'],
      cwd: '/work/repo',
      env: { [GROK_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/grok/8c8c0a1e' },
    });
  });
});

describe('Grok profile verification', () => {
  it('reads who is signed in, then the plan, from one agent bound to the profile root', async () => {
    const agent = signedIn();
    const identity = await service(agent).verify(managed);

    expect(identity).toEqual({
      loggedIn: true,
      method: 'cached_token',
      email: 'dev@example.com',
      plan: 'SuperGrok Heavy',
      verifiedAt: NOW.toISOString(),
      source: SOURCE,
    });
    expect(() => ProfileIdentitySchema.parse(identity)).not.toThrow();
    expect(agent.spawns).toEqual([
      {
        executable: EXECUTABLE,
        env: { PATH: '/usr/bin:/bin', HOME, GROK_HOME: '/home/tester/.puppeteer/profiles/grok/8c8c0a1e' },
      },
    ]);
    // No `authenticate`, no subscription check, no bearer or key method.
    expect(agent.methods()).toEqual(['initialize', '_x.ai/auth/info', '_x.ai/billing']);
    expect(agent.sent[0]?.params).toMatchObject({ protocolVersion: 1 });
    expect(agent.closed()).toBe(true);
  });

  it('accepts the camel-cased tier grok-build main sends', async () => {
    const agent = signedIn(SIGNED_IN_INFO, { result: { config: BILLING.config, subscriptionTier: 'SuperGrok' } });
    await expect(service(agent).verify(managed)).resolves.toMatchObject({ loggedIn: true, plan: 'SuperGrok' });
  });

  it('keeps a signed-in identity without a plan when billing fails or names none', async () => {
    const withoutPlan = {
      loggedIn: true,
      method: 'cached_token',
      email: 'dev@example.com',
      verifiedAt: NOW.toISOString(),
      source: SOURCE,
    };
    for (const billing of [AUTH_REQUIRED, { result: { config: BILLING.config } }, 'silent'] as const) {
      const agent = signedIn(SIGNED_IN_INFO, billing);
      await expect(service(agent, { requestTimeoutMs: 25 }).verify(managed)).resolves.toEqual(withoutPlan);
      expect(agent.closed()).toBe(true);
    }
  });

  it('reports a root without a credential as signed out and never reads billing', async () => {
    const agent = signedIn(SIGNED_OUT_INFO, AUTH_REQUIRED);
    await expect(service(agent).verify(managed)).resolves.toEqual({
      loggedIn: false,
      verifiedAt: NOW.toISOString(),
      source: SOURCE,
    });
    expect(agent.methods()).toEqual(['initialize', '_x.ai/auth/info']);
    expect(agent.closed()).toBe(true);
  });

  it('reads the interactive login methods as signed out without naming either', async () => {
    for (const methodId of ['grok.com', 'oidc']) {
      await expect(service(signedIn({ ...SIGNED_OUT_INFO, methodId })).verify(managed)).resolves.toEqual({
        loggedIn: false,
        verifiedAt: NOW.toISOString(),
        source: SOURCE,
      });
    }
  });

  it('reads an API-key sign-in, which has no email', async () => {
    const agent = signedIn({ ...SIGNED_OUT_INFO, methodId: 'xai.api_key' }, AUTH_REQUIRED);
    await expect(service(agent).verify(managed)).resolves.toEqual({
      loggedIn: true,
      method: 'xai.api_key',
      verifiedAt: NOW.toISOString(),
      source: SOURCE,
    });
  });

  it('fails rather than guessing when the identity document is unrecognized', async () => {
    const cases: Array<[unknown, string]> = [
      [{ email: 'dev@example.com' }, 'returned an unrecognized document'],
      [null, 'returned an unrecognized document'],
      ['signed in', 'returned an unrecognized document'],
      [[SIGNED_IN_INFO], 'returned an unrecognized document'],
      [{ methodId: 7 }, 'returned an unrecognized document'],
      [{ ...SIGNED_IN_INFO, methodId: 'device_code' }, 'named an unrecognized sign-in method'],
    ];
    for (const [info, message] of cases) {
      const agent = signedIn(info);
      await expect(service(agent).verify(managed)).resolves.toEqual({
        status: 'unavailable',
        provider: 'grok',
        message: `\`_x.ai/auth/info\` ${message}`,
        retryable: true,
      });
      expect(agent.methods()).toEqual(['initialize', '_x.ai/auth/info']);
      expect(agent.closed()).toBe(true);
    }
  });

  it('reports a Grok build without the identity method as unsupported', async () => {
    const agent = fakeAgent({ initialize: { result: { protocolVersion: 1, authMethods: [] } } });
    await expect(service(agent).verify(managed)).resolves.toEqual({
      status: 'unsupported',
      provider: 'grok',
      message: 'this Grok build does not answer `_x.ai/auth/info`',
      retryable: false,
    });
    expect(agent.closed()).toBe(true);
  });

  it('fails when the agent cannot start or does not answer', async () => {
    const unstartable = createGrokProfileService({
      executable: EXECUTABLE,
      home: HOME,
      env: {},
      spawnTransport: () => {
        throw new Error('spawn ENOENT');
      },
    });
    await expect(unstartable.verify(managed)).resolves.toMatchObject({ status: 'unavailable', retryable: true });

    const broken = fakeAgent({ initialize: { error: { code: -32_603, message: 'Internal error' } } });
    await expect(service(broken).verify(managed)).resolves.toMatchObject({ status: 'unavailable' });
    expect(broken.closed()).toBe(true);

    const hung = fakeAgent({ initialize: { result: {} }, '_x.ai/auth/info': 'silent' });
    await expect(service(hung, { requestTimeoutMs: 25 }).verify(managed)).resolves.toMatchObject({
      status: 'unavailable',
    });
    expect(hung.closed()).toBe(true);
  });

  it('probes in a clean environment that names no credential and no root but the profile', async () => {
    const ambient = {
      PATH: '/usr/bin:/bin',
      HOME,
      USER: 'tester',
      LOGNAME: 'tester',
      LANG: 'en_US.UTF-8',
      XAI_API_KEY: 'xai-ambient-key',
      GROK_CODE_XAI_API_KEY: 'xai-legacy-key',
      GROK_AUTH: '{"key":"inline"}',
      GROK_AUTH_PATH: '/elsewhere/auth.json',
      GROK_HOME: '/home/tester/.grok-other',
      OPENAI_API_KEY: 'sk-unrelated',
    };
    const kept = { PATH: '/usr/bin:/bin', HOME, USER: 'tester', LOGNAME: 'tester', LANG: 'en_US.UTF-8' };
    const agent = signedIn();
    const profiles = service(agent, { env: ambient });

    await profiles.verify(managed);
    await profiles.verify(nativeDefault);

    expect(agent.spawns.map((spawn) => spawn.env)).toEqual([
      { ...kept, GROK_HOME: '/home/tester/.puppeteer/profiles/grok/8c8c0a1e' },
      kept,
    ]);
  });

  it('never carries a token or a native error body into its result', async () => {
    // Fields `auth.json` keeps beside the email. The agent does not send them
    // here; a decoder that copied the document would.
    const agent = signedIn({
      ...SIGNED_IN_INFO,
      key: 'xai-session-secret',
      refresh_token: 'rt-secret',
      authorization: 'Bearer secret',
      authPath: '/home/tester/.grok/auth.json',
    });
    const identity = await service(agent).verify(managed);
    expect(identity).toMatchObject({ loggedIn: true, plan: 'SuperGrok Heavy' });
    expect(JSON.stringify(identity)).not.toMatch(/"key"|refresh_token|Bearer|auth\.json|secret/);

    const leaky = fakeAgent({
      initialize: { result: {} },
      '_x.ai/auth/info': { error: { code: -32_000, message: 'Bearer secret expired; see ~/.grok/auth.json' } },
    });
    const failure = await service(leaky).verify(managed);
    expect(failure).toMatchObject({ status: 'unavailable' });
    expect(JSON.stringify(failure)).not.toMatch(/Bearer|auth\.json|secret/);
  });
});

describe('Grok identity decoding', () => {
  const verifiedAt = NOW.toISOString();

  it('names the organization before the team, and never an id', () => {
    const base = { methodId: 'cached_token', organizationId: 'org-1', teamId: 'team-1' };
    expect(
      grokProfileIdentityFrom({ ...base, organizationName: 'Example Org', teamName: 'Platform' }, verifiedAt),
    ).toMatchObject({ organization: 'Example Org' });
    expect(grokProfileIdentityFrom({ ...base, organizationName: null, teamName: 'Platform' }, verifiedAt)).toEqual({
      loggedIn: true,
      method: 'cached_token',
      organization: 'Platform',
      verifiedAt,
      source: SOURCE,
    });
  });

  it('drops blank fields instead of emitting empty strings', () => {
    expect(
      grokProfileIdentityFrom(
        { methodId: 'cached_token', email: '  ', organizationName: '', teamName: ' ' },
        verifiedAt,
      ),
    ).toEqual({ loggedIn: true, method: 'cached_token', verifiedAt, source: SOURCE });
  });

  it('keeps a signed-out document signed out whatever else it carries', () => {
    expect(grokProfileIdentityFrom({ methodId: null, email: 'dev@example.com' }, verifiedAt)).toEqual({
      loggedIn: false,
      verifiedAt,
      source: SOURCE,
    });
  });
});
