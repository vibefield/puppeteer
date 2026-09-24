import {
  AgentProfileSchema,
  ProfileIdentitySchema,
  ProfileProviderSchema,
  type AgentProfile,
} from '@vibecook/puppeteer-core';
import { describe, expect, it } from 'vitest';
import type { CopilotServerTransport } from '../transport/server-client.js';
import {
  COPILOT_PROFILE_ROOT_VARIABLE,
  copilotPlanFrom,
  copilotProfileIdentityFrom,
  createCopilotProfileService,
} from './profiles.js';

const HOME = '/home/tester';
const ROOT = '/home/tester/.puppeteer/profiles/copilot/4f21b0c9';
const NOW = new Date('2026-09-23T12:00:00.000Z');
const VERIFIED_AT = NOW.toISOString();
const SOURCE = { kind: 'native-protocol', stability: 'experimental' } as const;

/** Planted in the ambient environment and in server documents; none may reach a spawn or a result. */
const ENV_SECRETS = { COPILOT_GITHUB_TOKEN: 'ghp_copilotenv', GH_TOKEN: 'ghp_ghenv', GITHUB_TOKEN: 'ghp_githubenv' };
const DOCUMENT_SECRET = 'gho_documentsecret';

const MINIMAL = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME,
  USER: 'tester',
  LOGNAME: 'tester',
  LANG: 'en_US.UTF-8',
  TMPDIR: '/var/folders/tester/T/',
};

const AMBIENT: NodeJS.ProcessEnv = {
  ...MINIMAL,
  ...ENV_SECRETS,
  COPILOT_HOME: '/home/tester/another-root',
  NODE_OPTIONS: '--require /tmp/inject.js',
  SSH_AUTH_SOCK: '/tmp/agent.sock',
};

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile =>
  AgentProfileSchema.parse({
    id: 'copilot:4f21b0c9',
    provider: 'copilot',
    label: 'Work',
    kind: 'managed',
    dataRoot: ROOT,
    createdAt: '2026-09-23T00:00:00.000Z',
    ...overrides,
  });

const managed = profile();
const nativeDefault = profile({
  id: 'copilot:native-default',
  kind: 'native-default',
  dataRoot: '/home/tester/.copilot',
});

const STATUS_USER = {
  isAuthenticated: true,
  authType: 'user',
  host: 'https://github.com',
  login: 'octo-dev',
  statusMessage: 'octo-dev',
};

/** The live 1.0.88 `user` snapshot's shape: no token, and a `token_based_billing` flag that is not one. */
const INDIVIDUAL = {
  copilot_plan: 'individual',
  access_type_sku: 'monthly_subscriber_quota',
  token_based_billing: true,
  organization_login_list: [],
  organization_list: [],
};

const currentAuth = (copilotUser: Record<string, unknown>, authInfo: Record<string, unknown> = {}) => ({
  authInfo: { type: 'user', host: 'https://github.com', login: 'octo-dev', copilotUser, ...authInfo },
});

type Reply = { result: unknown } | { error: { code: number; message: string } };

const PONG: Reply = { result: { message: 'pong', timestamp: '2026-09-23T12:00:00.000Z', protocolVersion: 3 } };

/** A scripted Copilot server: answers the methods it is given, records how it was spawned and what it was asked. */
function fakeServer(replies: Record<string, Reply>): {
  spawnTransport: (options: { executable: string; env: Record<string, string> }) => CopilotServerTransport;
  spawns: Array<{ executable: string; env: Record<string, string> }>;
  methods: string[];
  closed: () => boolean;
} {
  const spawns: Array<{ executable: string; env: Record<string, string> }> = [];
  const methods: string[] = [];
  let isClosed = false;
  return {
    spawns,
    methods,
    closed: () => isClosed,
    spawnTransport(options) {
      spawns.push(options);
      let onMessage: ((message: unknown) => void) | undefined;
      return {
        send(message) {
          const request = message as { id?: number; method?: string };
          if (typeof request.method === 'string') methods.push(request.method);
          const reply = request.method === undefined ? undefined : replies[request.method];
          if (request.id === undefined || reply === undefined) return;
          queueMicrotask(() => onMessage?.({ jsonrpc: '2.0', id: request.id, ...reply }));
        },
        onMessage(handler) {
          onMessage = handler;
        },
        onClose() {},
        async close() {
          isClosed = true;
        },
      };
    },
  };
}

function service(
  server: ReturnType<typeof fakeServer>,
  overrides: Partial<Parameters<typeof createCopilotProfileService>[0]> = {},
): ReturnType<typeof createCopilotProfileService> {
  return createCopilotProfileService({
    home: HOME,
    executable: '/opt/copilot/bin/copilot',
    env: AMBIENT,
    now: () => NOW,
    requestTimeoutMs: 50,
    spawnTransport: server.spawnTransport,
    ...overrides,
  });
}

function expectNoSecrets(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const secret of [...Object.values(ENV_SECRETS), DOCUMENT_SECRET]) expect(serialized).not.toContain(secret);
}

describe('Copilot profile provider', () => {
  const profiles = service(fakeServer({}));

  it('declares identity through the native protocol, an external credential and GitHub as the service', () => {
    expect(() => ProfileProviderSchema.parse(profiles.provider)).not.toThrow();
    expect(profiles.provider).toEqual({
      id: 'copilot',
      label: 'GitHub Copilot',
      support: {
        supported: true,
        identity: 'native-protocol',
        sharedSurfaces: [
          '/home/tester/.agents/skills',
          'one copilot-cli keychain item per GitHub login',
          "GitHub CLI's login in any root without a Copilot login",
        ],
        nativeDefaultRoot: '/home/tester/.copilot',
        credential: 'external',
        service: { id: 'github', label: 'GitHub' },
      },
    });
  });

  it('offers no sign-out: logout would remove a keychain item other roots share', () => {
    expect(profiles.signOut).toBeUndefined();
  });

  it('binds a managed profile through the native root variable', () => {
    expect(profiles.bindingEnvironment(managed)).toEqual({ [COPILOT_PROFILE_ROOT_VARIABLE]: ROOT });
  });

  it('injects nothing for the native default profile', () => {
    expect(profiles.bindingEnvironment(nativeDefault)).toEqual({});
  });

  it('names the history layout root for an indexer', () => {
    expect(profiles.observationRoot(managed)).toBe(ROOT);
    expect(profiles.observationRoot(nativeDefault)).toBe('/home/tester/.copilot');
  });

  it('runs the native interactive login inside the profile binding', () => {
    expect(profiles.loginInvocation(managed, { cwd: '/work/repo' })).toEqual({
      command: '/opt/copilot/bin/copilot',
      args: ['login'],
      cwd: '/work/repo',
      env: { [COPILOT_PROFILE_ROOT_VARIABLE]: ROOT },
    });
  });

  it('takes the executable from the ambient override when none is given', () => {
    const fromEnv = createCopilotProfileService({ home: HOME, env: { PUPPETEER_COPILOT_BIN: '/custom/copilot' } });
    expect(fromEnv.loginInvocation(managed, { cwd: '/work/repo' }).command).toBe('/custom/copilot');
  });
});

describe('Copilot profile verification', () => {
  it('reads a Copilot login and its plan through the server bound to the profile root', async () => {
    const server = fakeServer({
      ping: PONG,
      'auth.getStatus': { result: STATUS_USER },
      'account.getCurrentAuth': { result: currentAuth(INDIVIDUAL) },
    });
    const identity = await service(server).verify(managed);
    expect(identity).toEqual({
      loggedIn: true,
      method: 'user',
      account: 'octo-dev',
      plan: 'individual',
      verifiedAt: VERIFIED_AT,
      source: SOURCE,
    });
    expect(() => ProfileIdentitySchema.parse(identity)).not.toThrow();
    expect(server.spawns).toEqual([
      { executable: '/opt/copilot/bin/copilot', env: { ...MINIMAL, [COPILOT_PROFILE_ROOT_VARIABLE]: ROOT } },
    ]);
    expect(server.methods).toEqual(['ping', 'auth.getStatus', 'account.getCurrentAuth']);
    expect(server.closed()).toBe(true);
    expectNoSecrets(identity);
  });

  it('names the organization a seat comes through when there is exactly one', async () => {
    const server = fakeServer({
      ping: PONG,
      'auth.getStatus': { result: STATUS_USER },
      'account.getCurrentAuth': {
        result: currentAuth({ copilot_plan: 'business', organization_login_list: ['acme'] }),
      },
    });
    expect(await service(server).verify(managed)).toMatchObject({
      account: 'octo-dev',
      organization: 'acme',
      plan: 'business',
    });
  });

  it('reports a root with no Copilot login as the GitHub CLI user it will run as, without a plan', async () => {
    const server = fakeServer({
      ping: PONG,
      'auth.getStatus': { result: { ...STATUS_USER, authType: 'gh-cli' } },
      // Specified to carry `gh auth token`; never asked for.
      'account.getCurrentAuth': {
        result: currentAuth(INDIVIDUAL, { type: 'gh-cli', token: DOCUMENT_SECRET }),
      },
    });
    const identity = await service(server).verify(managed);
    expect(identity).toEqual({
      loggedIn: true,
      method: 'gh-cli',
      account: 'octo-dev',
      borrowedFrom: 'GitHub CLI',
      verifiedAt: VERIFIED_AT,
      source: SOURCE,
    });
    expect(server.methods).toEqual(['ping', 'auth.getStatus']);
    expectNoSecrets(identity);
  });

  it.each([
    ['an environment variable', { authType: 'env', login: 'octo-dev' }, { method: 'env', account: 'octo-dev' }],
    ['a raw token', { authType: 'token' }, { method: 'token' }],
  ])('passes a credential from %s through without asking for a plan', async (_label, status, expected) => {
    const server = fakeServer({
      ping: PONG,
      'auth.getStatus': { result: { isAuthenticated: true, host: 'https://github.com', ...status } },
      'account.getCurrentAuth': { result: currentAuth(INDIVIDUAL, { token: DOCUMENT_SECRET }) },
    });
    const identity = await service(server).verify(managed);
    expect(identity).toEqual({ loggedIn: true, ...expected, verifiedAt: VERIFIED_AT, source: SOURCE });
    expect(server.methods).toEqual(['ping', 'auth.getStatus']);
    expectNoSecrets(identity);
  });

  it('reports a signed-out root as signed out, whatever login it once recorded', async () => {
    const server = fakeServer({
      ping: PONG,
      'auth.getStatus': { result: { isAuthenticated: false, login: 'octo-dev', statusMessage: 'Not signed in' } },
    });
    expect(await service(server).verify(managed)).toEqual({ loggedIn: false, verifiedAt: VERIFIED_AT, source: SOURCE });
    expect(server.methods).toEqual(['ping', 'auth.getStatus']);
  });

  it('never forwards a token variable, an inherited root, or anything outside the probe allow-list', async () => {
    const windowsAndLocale = {
      LC_ALL: 'en_US.UTF-8',
      LC_CTYPE: 'UTF-8',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      TMP: 'C:\\Temp',
      USERPROFILE: 'C:\\Users\\tester',
    };
    const server = fakeServer({ ping: PONG, 'auth.getStatus': { result: { isAuthenticated: false } } });
    const profiles = service(server, { env: { ...AMBIENT, ...windowsAndLocale } });
    await profiles.verify(managed);
    await profiles.verify(nativeDefault);
    expect(server.spawns.map((spawn) => spawn.env)).toEqual([
      { ...MINIMAL, ...windowsAndLocale, [COPILOT_PROFILE_ROOT_VARIABLE]: ROOT },
      { ...MINIMAL, ...windowsAndLocale },
    ]);
    expectNoSecrets(server.spawns);
  });

  it.each([
    ['another protocol version', { result: { message: 'pong', protocolVersion: 4 } }],
    ['no protocol version', { result: { message: 'pong' } }],
    ['an error', { error: { code: -32601, message: 'method not found' } }],
  ] satisfies Array<[string, Reply]>)('refuses a server whose ping answers with %s', async (_label, reply) => {
    const server = fakeServer({ ping: reply, 'auth.getStatus': { result: STATUS_USER } });
    expect(await service(server).verify(managed)).toMatchObject({
      status: 'unavailable',
      provider: 'copilot',
      retryable: true,
    });
    expect(server.methods).toEqual(['ping']);
    expect(server.closed()).toBe(true);
  });

  it('treats an unrecognized status as unavailable, not as signed out', async () => {
    const server = fakeServer({ ping: PONG, 'auth.getStatus': { result: { authType: 'user', login: 'octo-dev' } } });
    expect(await service(server).verify(managed)).toMatchObject({ status: 'unavailable', provider: 'copilot' });
    expect(server.closed()).toBe(true);
  });

  it('fails when the server does not answer, and still stops it', async () => {
    const server = fakeServer({ ping: PONG });
    expect(await service(server).verify(managed)).toMatchObject({ status: 'unavailable', retryable: true });
    expect(server.methods).toEqual(['ping', 'auth.getStatus']);
    expect(server.closed()).toBe(true);
  });

  it.each([
    ['beside the login', currentAuth(INDIVIDUAL, { token: DOCUMENT_SECRET })],
    ['inside the snapshot', currentAuth({ ...INDIVIDUAL, endpoints: { api: 'https://api', token: DOCUMENT_SECRET } })],
    ['as an HMAC', { ...currentAuth(INDIVIDUAL), hmac: DOCUMENT_SECRET }],
    ['as an API key', currentAuth(INDIVIDUAL, { apiKey: DOCUMENT_SECRET })],
    ['under another spelling', currentAuth({ ...INDIVIDUAL, access_token: DOCUMENT_SECRET })],
  ])('discards a plan document that carries a secret %s and keeps the status', async (_label, document) => {
    const server = fakeServer({
      ping: PONG,
      'auth.getStatus': { result: STATUS_USER },
      'account.getCurrentAuth': { result: document },
    });
    const identity = await service(server).verify(managed);
    expect(identity).toEqual({
      loggedIn: true,
      method: 'user',
      account: 'octo-dev',
      verifiedAt: VERIFIED_AT,
      source: SOURCE,
    });
    expectNoSecrets(identity);
  });

  it.each([
    ['answers with an error', { 'account.getCurrentAuth': { error: { code: -32603, message: 'internal' } } }],
    ['never answers', {}],
  ] satisfies Array<[string, Record<string, Reply>]>)(
    'keeps the status without a plan when the plan read %s',
    async (_label, replies) => {
      const server = fakeServer({ ping: PONG, 'auth.getStatus': { result: STATUS_USER }, ...replies });
      expect(await service(server).verify(managed)).toEqual({
        loggedIn: true,
        method: 'user',
        account: 'octo-dev',
        verifiedAt: VERIFIED_AT,
        source: SOURCE,
      });
      expect(server.closed()).toBe(true);
    },
  );
});

describe('Copilot status decoding', () => {
  it.each([
    ['nothing', undefined],
    ['a list', [STATUS_USER]],
    ['no isAuthenticated', { authType: 'user', login: 'octo-dev' }],
    ['a string for isAuthenticated', { ...STATUS_USER, isAuthenticated: 'true' }],
  ])('treats %s as unrecognized', (_label, document) => {
    expect(copilotProfileIdentityFrom(document, VERIFIED_AT)).toMatchObject({ status: 'unavailable' });
  });

  it('refuses a status that carries a secret, and does not repeat it', () => {
    const failure = copilotProfileIdentityFrom({ ...STATUS_USER, token: DOCUMENT_SECRET }, VERIFIED_AT);
    expect(failure).toMatchObject({ status: 'unavailable' });
    expectNoSecrets(failure);
  });

  it('reads the account from login, not from the status message', () => {
    expect(
      copilotProfileIdentityFrom({ ...STATUS_USER, statusMessage: 'Signed in as someone-else' }, VERIFIED_AT),
    ).toMatchObject({ loggedIn: true, account: 'octo-dev' });
  });
});

describe('Copilot plan decoding', () => {
  it.each([
    ['none for an individual plan', [], {}],
    ['the one organization', ['acme'], { organization: 'acme' }],
    ['none when several could bill the login', ['acme', 'globex'], {}],
    ['none for an entry that is not a login', [42], {}],
  ])('names %s', (_label, organizations, expected) => {
    expect(
      copilotPlanFrom(currentAuth({ copilot_plan: 'business', organization_login_list: organizations }), 'octo-dev'),
    ).toEqual({ plan: 'business', ...expected });
  });

  it.each([
    ['another credential', currentAuth(INDIVIDUAL, { type: 'tokenProvider' }), 'octo-dev'],
    ['another login', currentAuth(INDIVIDUAL, { login: 'someone-else' }), 'octo-dev'],
    ['a status without a login', currentAuth(INDIVIDUAL), undefined],
    ['no authInfo', { authErrors: ['expired'] }, 'octo-dev'],
  ])('takes nothing from a document about %s', (_label, document, account) => {
    expect(copilotPlanFrom(document, account)).toEqual({});
  });

  it('matches the login regardless of case, as GitHub does', () => {
    expect(copilotPlanFrom(currentAuth(INDIVIDUAL, { login: 'Octo-Dev' }), 'octo-dev')).toEqual({ plan: 'individual' });
  });
});
