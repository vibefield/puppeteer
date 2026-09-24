import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AgentProfileSchema,
  ProfileIdentitySchema,
  ProfileProviderSchema,
  type AgentProfile,
  type ProfileIdentity,
  type ProfileService,
} from '@vibecook/puppeteer-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeOpenCodeNativeInvocation } from '../launch/native-invocation.js';
import {
  createOpenCodeProfileService,
  openCodeConsoleOrgsFrom,
  openCodeDataHome,
  openCodeStoredCredentials,
  OPENCODE_PROFILE_ROOT_VARIABLE,
  type OpenCodeConsoleOrgsRequest,
} from './profiles.js';

const service = createOpenCodeProfileService({ home: '/home/tester', executable: 'opencode' });

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile =>
  AgentProfileSchema.parse({
    id: 'opencode:77c5b0ad',
    provider: 'opencode',
    label: 'Work',
    kind: 'managed',
    dataRoot: '/home/tester/.puppeteer/profiles/opencode/77c5b0ad',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

/** Every token, key, and field stored beside one in the fixtures carries this; no result may. */
const SECRET = 'SECRET';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'puppeteer-opencode-profiles-')));
  roots.push(root);
  return root;
}

/** `opencode.db` with the 1.18.32 account tables, token columns filled. */
function writeConsoleStore(
  directory: string,
  accounts: ReadonlyArray<{ id: string; email: string }>,
  active?: { account: string; org: string },
): void {
  mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(join(directory, 'opencode.db'));
  try {
    database.exec('PRAGMA journal_mode = WAL');
    database.exec(`
      CREATE TABLE account (
        id text PRIMARY KEY, email text NOT NULL, url text NOT NULL, access_token text NOT NULL,
        refresh_token text NOT NULL, token_expiry integer, time_created integer NOT NULL, time_updated integer NOT NULL
      );
      CREATE TABLE account_state (
        id integer PRIMARY KEY, active_account_id text REFERENCES account(id) ON DELETE SET NULL, active_org_id text
      );
    `);
    const insert = database.prepare('INSERT INTO account VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const account of accounts) {
      const url = 'https://opencode.ai/console';
      insert.run(account.id, account.email, url, `${SECRET}-access`, `${SECRET}-refresh`, 1, 1, 1);
    }
    if (active) database.prepare('INSERT INTO account_state VALUES (1, ?, ?)').run(active.account, active.org);
  } finally {
    database.close();
  }
}

function writeCredentialStore(directory: string, store: unknown): void {
  mkdirSync(directory, { recursive: true });
  const document = typeof store === 'string' ? store : JSON.stringify(store);
  writeFileSync(join(directory, 'auth.json'), document, { mode: 0o600 });
}

const OAUTH = { refresh: `${SECRET}-refresh`, access: `${SECRET}-access`, expires: 1_790_000_000_000 };

/** The union 1.18.32 writes, one of each shape, plus entries OpenCode's own decoder drops. */
const CREDENTIALS = {
  openai: { type: 'oauth', ...OAUTH, accountId: `${SECRET}-chatgpt-account` },
  anthropic: { type: 'api', key: `${SECRET}-anthropic`, metadata: { region: `${SECRET}-form-field` } },
  'github-copilot': { type: 'oauth', ...OAUTH, expires: 0, enterpriseUrl: `${SECRET}.ghe.example` },
  'opencode-go': { type: 'api', key: `${SECRET}-go` },
  'moonshotai-cn': { type: 'api', key: `${SECRET}-moonshot` },
  gitlab: { type: 'oauth', ...OAUTH },
  [`https://${SECRET}@ai.corp.example/path?token=${SECRET}`]: {
    type: 'wellknown',
    key: `${SECRET}_CORP_TOKEN`,
    token: `${SECRET}-wellknown`,
  },
  'my-gateway': { type: 'api', key: `${SECRET}-gateway` },
  [`https://${SECRET}:${SECRET}@`]: { type: 'wellknown', key: 'HOSTLESS', token: `${SECRET}-hostless` },
  'missing-key': { type: 'api' },
  'negative-expiry': { type: 'oauth', ...OAUTH, expires: -1 },
  'numeric-metadata': { type: 'api', key: `${SECRET}-numeric`, metadata: { tier: 3 } },
  'future-shape': { type: 'session', key: `${SECRET}-future` },
};

const PROVIDER_SIGN_INS = [
  { service: { id: 'openai', label: 'OpenAI' }, method: 'oauth', subscription: true },
  { service: { id: 'anthropic', label: 'Anthropic' }, method: 'api-key' },
  { service: { id: 'github', label: 'GitHub' }, method: 'oauth', subscription: true },
  { service: { id: 'opencode', label: 'OpenCode' }, method: 'api-key' },
  { service: { id: 'kimi', label: 'Moonshot AI' }, method: 'api-key' },
  { service: { id: 'gitlab', label: 'gitlab' }, method: 'oauth' },
  { service: { id: 'ai.corp.example', label: 'ai.corp.example' }, method: 'wellknown' },
  { service: { id: 'my-gateway', label: 'my-gateway' }, method: 'api-key' },
];

const CONSOLE = { id: 'opencode', label: 'OpenCode' };

/** A reader that records what it was asked and answers without a server. */
function orgsReader(answer: () => unknown) {
  const requests: OpenCodeConsoleOrgsRequest[] = [];
  const read = vi.fn(async (request: OpenCodeConsoleOrgsRequest) => {
    requests.push(request);
    return answer();
  });
  return { read, requests };
}

async function verified(subject: ProfileService, account: AgentProfile): Promise<ProfileIdentity> {
  const outcome = await subject.verify(account);
  expect(JSON.stringify(outcome)).not.toContain(SECRET);
  expect(outcome).not.toHaveProperty('status');
  return ProfileIdentitySchema.parse(outcome);
}

describe('OpenCode profiles', () => {
  it('advertises the native XDG data root, the surfaces that stay shared, and both sign-in routes', () => {
    expect(() => ProfileProviderSchema.parse(service.provider)).not.toThrow();
    expect(service.provider.support).toMatchObject({
      supported: true,
      identity: 'native-protocol',
      nativeDefaultRoot: '/home/tester/.local/share/opencode',
      credential: 'root',
      service: CONSOLE,
      signInRoutes: [
        { id: 'provider', label: 'Another provider…' },
        { id: 'console', label: 'OpenCode Console', service: CONSOLE },
      ],
    });
    expect(service.provider.support.sharedSurfaces.length).toBeGreaterThan(0);
  });

  it('binds a managed profile through XDG_DATA_HOME one level inside the root', () => {
    expect(openCodeDataHome(profile())).toBe('/home/tester/.puppeteer/profiles/opencode/77c5b0ad/data');
    expect(service.bindingEnvironment(profile())).toEqual({
      [OPENCODE_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/opencode/77c5b0ad/data',
    });
  });

  it('injects nothing for the native default profile', () => {
    expect(
      service.bindingEnvironment(profile({ kind: 'native-default', dataRoot: '/home/tester/.local/share/opencode' })),
    ).toEqual({});
  });

  it('names the history layout root one opencode level below the bound data home', () => {
    expect(service.observationRoot(profile())).toBe('/home/tester/.puppeteer/profiles/opencode/77c5b0ad/data/opencode');
    expect(
      service.observationRoot(profile({ kind: 'native-default', dataRoot: '/home/tester/.local/share/opencode' })),
    ).toBe('/home/tester/.local/share/opencode');
  });

  it('runs the provider login by default and the Console login on its route, both inside the binding', () => {
    const env = { [OPENCODE_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/opencode/77c5b0ad/data' };
    expect(service.loginInvocation(profile(), { cwd: '/work/repo' })).toEqual({
      command: 'opencode',
      args: ['auth', 'login'],
      cwd: '/work/repo',
      env,
    });
    expect(service.loginInvocation(profile(), { cwd: '/work/repo', route: 'provider' }).args).toEqual([
      'auth',
      'login',
    ]);
    expect(service.loginInvocation(profile(), { cwd: '/work/repo', route: 'console' })).toEqual({
      command: 'opencode',
      args: ['console', 'login'],
      cwd: '/work/repo',
      env,
    });
    expect(() => service.loginInvocation(profile(), { cwd: '/work/repo', route: 'nous' })).toThrow(
      'unknown OpenCode sign-in route',
    );
  });

  it('produces a binding the adapter turns into launch options', () => {
    // The composition root normalizes bindingEnvironment through the adapter's
    // own invocation normalizer, so the two must agree.
    const resolution = normalizeOpenCodeNativeInvocation({
      providerId: 'opencode',
      cwd: '/work/repo',
      argv: [],
      environment: service.bindingEnvironment(profile()),
      implementation: { kind: 'native' },
    });
    expect(resolution).toEqual({
      status: 'accepted',
      options: { env: { XDG_DATA_HOME: '/home/tester/.puppeteer/profiles/opencode/77c5b0ad/data' } },
    });
  });
});

describe('OpenCode sign-in decoders', () => {
  it('reduces auth.json to provider id and type, keeping only the entries OpenCode would', () => {
    const credentials = openCodeStoredCredentials(JSON.stringify(CREDENTIALS));
    expect(credentials).toEqual([
      { providerId: 'openai', type: 'oauth' },
      { providerId: 'anthropic', type: 'api' },
      { providerId: 'github-copilot', type: 'oauth' },
      { providerId: 'opencode-go', type: 'api' },
      { providerId: 'moonshotai-cn', type: 'api' },
      { providerId: 'gitlab', type: 'oauth' },
      { providerId: 'ai.corp.example', type: 'wellknown' },
      { providerId: 'my-gateway', type: 'api' },
    ]);
    expect(JSON.stringify(credentials)).not.toContain(SECRET);
    expect(openCodeStoredCredentials('{"openai":{"type":"oauth","access":"')).toBeUndefined();
    expect(openCodeStoredCredentials('[]')).toBeUndefined();
    expect(openCodeStoredCredentials('{}')).toEqual([]);
  });

  it('keeps only account, org name, and the active mark from the org list', () => {
    expect(
      openCodeConsoleOrgsFrom({
        orgs: [
          {
            accountID: 'usr_work',
            accountEmail: 'work@example.com',
            accountUrl: 'https://opencode.ai/console',
            orgID: 'org_work',
            orgName: ' Work ',
            active: true,
            accessToken: `${SECRET}-leaked-by-a-future-route`,
          },
          { accountID: 'usr_home', orgName: 'Home', active: 'yes' },
          { accountID: 'usr_nameless', active: true },
          'not an org',
        ],
      }),
    ).toEqual([
      { accountId: 'usr_work', name: 'Work', active: true },
      { accountId: 'usr_home', name: 'Home', active: false },
    ]);
    expect(openCodeConsoleOrgsFrom({ consoleManagedProviders: [] })).toEqual([]);
    expect(openCodeConsoleOrgsFrom(undefined)).toEqual([]);
  });
});

describe('OpenCode profile verification', () => {
  const at = new Date('2026-09-23T12:00:00.000Z');

  it('reads a root that holds nothing as signed out without starting a server', async () => {
    const dataRoot = join(scratch(), 'profile');
    const reader = orgsReader(() => ({ orgs: [] }));
    const subject = createOpenCodeProfileService({
      executable: 'opencode',
      readConsoleOrgs: reader.read,
      now: () => at,
    });

    await expect(verified(subject, profile({ dataRoot }))).resolves.toEqual({
      loggedIn: false,
      signIns: [],
      verifiedAt: at.toISOString(),
      source: { kind: 'native-protocol', stability: 'experimental' },
    });

    // An initialized store with no Console account and no credential is signed out too.
    writeConsoleStore(join(dataRoot, 'data', 'opencode'), []);
    writeCredentialStore(join(dataRoot, 'data', 'opencode'), {});
    await expect(verified(subject, profile({ dataRoot }))).resolves.toMatchObject({ loggedIn: false, signIns: [] });
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('lists every Console account with its org, and every provider credential, by service', async () => {
    const dataRoot = join(scratch(), 'profile');
    const directory = join(dataRoot, 'data', 'opencode');
    writeConsoleStore(
      directory,
      [
        { id: 'usr_home', email: 'home@example.com' },
        { id: 'usr_work', email: 'work@example.com' },
        { id: 'usr_club', email: 'club@example.com' },
      ],
      { account: 'usr_work', org: 'org_work' },
    );
    writeCredentialStore(directory, CREDENTIALS);
    const org = (accountID: string, orgID: string, orgName: string, active = false) => ({
      accountID,
      accountEmail: `${accountID}@example.com`,
      accountUrl: 'https://opencode.ai/console',
      orgID,
      orgName,
      active,
    });
    const reader = orgsReader(() => ({
      orgs: [
        { ...org('usr_home', 'org_home', 'Home'), accessToken: `${SECRET}-leaked-by-a-future-route` },
        org('usr_work', 'org_side', 'Side'),
        org('usr_work', 'org_work', 'Work', true),
        org('usr_club', 'org_a', 'Club A'),
        org('usr_club', 'org_b', 'Club B'),
      ],
    }));
    const subject = createOpenCodeProfileService({
      executable: '/opt/opencode/bin/opencode',
      readConsoleOrgs: reader.read,
      requestTimeoutMs: 1_234,
      now: () => at,
    });

    const identity = await verified(subject, profile({ dataRoot }));
    expect(identity).toEqual({
      loggedIn: true,
      signIns: [
        // The active account first; an account with several orgs and none active names none.
        { service: CONSOLE, method: 'console', email: 'work@example.com', organization: 'Work' },
        { service: CONSOLE, method: 'console', email: 'home@example.com', organization: 'Home' },
        { service: CONSOLE, method: 'console', email: 'club@example.com' },
        ...PROVIDER_SIGN_INS,
      ],
      verifiedAt: at.toISOString(),
      source: { kind: 'native-protocol', stability: 'experimental' },
    });
    // Nothing is in use, so the top level repeats nobody's details.
    expect(identity).not.toHaveProperty('email');
    expect(identity).not.toHaveProperty('method');
    expect(reader.requests).toEqual([
      {
        executable: '/opt/opencode/bin/opencode',
        env: { XDG_DATA_HOME: join(dataRoot, 'data') },
        timeoutMs: 1_234,
      },
    ]);
  });

  it('keeps the Console account and its email when the console cannot name its org', async () => {
    const dataRoot = join(scratch(), 'profile');
    writeConsoleStore(join(dataRoot, 'data', 'opencode'), [{ id: 'usr_work', email: 'work@example.com' }], {
      account: 'usr_work',
      org: 'org_work',
    });
    const expected = [{ service: CONSOLE, method: 'console', email: 'work@example.com' }];

    // OpenCode's own answer when the console is down: the account's orgs collapse to none.
    for (const answer of [
      () => ({ orgs: [] }),
      () => {
        throw new Error('OpenCode backend did not become ready within 15000ms');
      },
      () => ({ consoleManagedProviders: [] }),
      () => 'not json',
    ]) {
      const subject = createOpenCodeProfileService({
        executable: 'opencode',
        readConsoleOrgs: orgsReader(answer).read,
      });
      const identity = await verified(subject, profile({ dataRoot }));
      expect(identity.loggedIn).toBe(true);
      expect(identity.signIns).toEqual(expected);
    }
  });

  it('lists provider credentials alone as signed in, without starting a server', async () => {
    const dataRoot = join(scratch(), 'profile');
    writeCredentialStore(join(dataRoot, 'data', 'opencode'), CREDENTIALS);
    const reader = orgsReader(() => ({ orgs: [] }));
    const subject = createOpenCodeProfileService({ executable: 'opencode', readConsoleOrgs: reader.read });

    const identity = await verified(subject, profile({ dataRoot }));
    expect(identity.loggedIn).toBe(true);
    expect(identity.signIns).toEqual(PROVIDER_SIGN_INS);
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('reads the native default from its own root, whatever XDG_DATA_HOME the host carries', async () => {
    const home = scratch();
    const directory = join(home, '.local', 'share', 'opencode');
    writeConsoleStore(directory, [{ id: 'usr_work', email: 'work@example.com' }], {
      account: 'usr_work',
      org: 'org_work',
    });
    writeCredentialStore(directory, { anthropic: CREDENTIALS.anthropic });
    vi.stubEnv('XDG_DATA_HOME', join(home, 'elsewhere'));
    const reader = orgsReader(() => ({ orgs: [] }));
    const subject = createOpenCodeProfileService({ home, executable: 'opencode', readConsoleOrgs: reader.read });

    const native = profile({ id: 'opencode:native', kind: 'native-default', dataRoot: directory });
    expect((await verified(subject, native)).signIns).toEqual([
      { service: CONSOLE, method: 'console', email: 'work@example.com' },
      { service: { id: 'anthropic', label: 'Anthropic' }, method: 'api-key' },
    ]);
    expect(reader.requests[0]?.env).toEqual({ XDG_DATA_HOME: join(home, '.local', 'share') });
  });

  it('never reads a token column', async () => {
    // Token columns computed by a function only the writer registered: any
    // statement that reads one fails on the verifier's connection.
    const dataRoot = join(scratch(), 'profile');
    const directory = join(dataRoot, 'data', 'opencode');
    mkdirSync(directory, { recursive: true });
    const database = new DatabaseSync(join(directory, 'opencode.db'));
    database.function('token_tripwire', { deterministic: true }, () => `${SECRET}-token`);
    database.exec(`
      CREATE TABLE account (
        id text PRIMARY KEY, email text NOT NULL, url text NOT NULL,
        access_token text GENERATED ALWAYS AS (token_tripwire()) VIRTUAL,
        refresh_token text GENERATED ALWAYS AS (token_tripwire()) VIRTUAL,
        token_expiry integer GENERATED ALWAYS AS (length(token_tripwire())) VIRTUAL
      );
      CREATE TABLE account_state (id integer PRIMARY KEY, active_account_id text, active_org_id text);
      INSERT INTO account (id, email, url) VALUES ('usr_work', 'work@example.com', 'https://opencode.ai/console');
      INSERT INTO account_state VALUES (1, 'usr_work', 'org_work');
    `);
    database.close();
    const subject = createOpenCodeProfileService({
      executable: 'opencode',
      readConsoleOrgs: orgsReader(() => ({ orgs: [] })).read,
    });

    expect((await verified(subject, profile({ dataRoot }))).signIns).toEqual([
      { service: CONSOLE, method: 'console', email: 'work@example.com' },
    ]);
  });

  it('refuses a database without the Console account tables instead of calling it signed out', async () => {
    const dataRoot = join(scratch(), 'profile');
    const directory = join(dataRoot, 'data', 'opencode');
    mkdirSync(directory, { recursive: true });
    const database = new DatabaseSync(join(directory, 'opencode.db'));
    database.exec('CREATE TABLE session (id text PRIMARY KEY)');
    database.close();
    const subject = createOpenCodeProfileService({
      executable: 'opencode',
      readConsoleOrgs: orgsReader(() => ({})).read,
    });

    await expect(subject.verify(profile({ dataRoot }))).resolves.toMatchObject({
      status: 'unavailable',
      provider: 'opencode',
      retryable: true,
    });
  });

  it('refuses an auth.json it cannot read without echoing any of it', async () => {
    const dataRoot = join(scratch(), 'profile');
    const directory = join(dataRoot, 'data', 'opencode');
    const subject = createOpenCodeProfileService({
      executable: 'opencode',
      readConsoleOrgs: orgsReader(() => ({})).read,
    });

    // A torn write, a document of another shape, and a path that is not a file.
    for (const store of [`{"anthropic":{"type":"api","key":"${SECRET}-anthropic`, `["${SECRET}"]`]) {
      writeCredentialStore(directory, store);
      const outcome = await subject.verify(profile({ dataRoot }));
      expect(outcome).toMatchObject({ status: 'unavailable', provider: 'opencode', retryable: true });
      expect(JSON.stringify(outcome)).not.toContain(SECRET);
    }
    rmSync(join(directory, 'auth.json'));
    mkdirSync(join(directory, 'auth.json'));
    await expect(subject.verify(profile({ dataRoot }))).resolves.toMatchObject({ status: 'unavailable' });
  });
});

/**
 * A stand-in for `opencode serve`: the readiness line, Basic auth from the
 * environment, and the org route, whose one org name reports what the server
 * was given. It is the adapter's own fixture, not the vendor binary.
 */
const FAKE_SERVE = (hang: boolean) => `
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
const expected = 'Basic ' + Buffer.from(process.env.OPENCODE_SERVER_USERNAME + ':' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (request.headers.authorization !== expected) return void response.writeHead(401).end();
  if (url.pathname !== '/experimental/console/orgs') return void response.writeHead(404).end();
  if (${hang}) return;
  const directory = url.searchParams.get('directory');
  const orgName = JSON.stringify({
    argv: process.argv.slice(2),
    dataHome: process.env.XDG_DATA_HOME,
    directory,
    directoryExisted: directory !== null && existsSync(directory),
  });
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ orgs: [{ accountID: 'usr_work', accountEmail: 'work@example.com', accountUrl: 'https://opencode.ai/console', orgID: 'org_work', orgName, active: true }] }));
});
server.listen(0, '127.0.0.1', () => console.log('opencode server listening on http://127.0.0.1:' + server.address().port));
`;

describe('OpenCode profile verification through a private serve', () => {
  function signedInRoot(): { root: string; dataRoot: string } {
    const root = scratch();
    const dataRoot = join(root, 'profile');
    writeConsoleStore(join(dataRoot, 'data', 'opencode'), [{ id: 'usr_work', email: 'work@example.com' }], {
      account: 'usr_work',
      org: 'org_work',
    });
    return { root, dataRoot };
  }

  it('asks a loopback serve bound to the root, then removes the directory it loaded', async () => {
    const { root, dataRoot } = signedInRoot();
    const executable = join(root, 'opencode.mjs');
    writeFileSync(executable, FAKE_SERVE(false));
    const subject = createOpenCodeProfileService({ home: root, executable });

    const identity = await verified(subject, profile({ dataRoot }));
    const organization = identity.signIns?.[0]?.organization;
    expect(organization).toBeDefined();
    const seen = JSON.parse(organization!) as Record<string, unknown>;
    expect(seen).toMatchObject({
      argv: ['serve', '--hostname', '127.0.0.1', '--port', '0', '--pure'],
      dataHome: join(dataRoot, 'data'),
      directoryExisted: true,
    });
    expect(existsSync(String(seen.directory))).toBe(false);
  });

  it('gives up on a console that does not answer within the budget and keeps the account', async () => {
    const { root, dataRoot } = signedInRoot();
    const executable = join(root, 'opencode.mjs');
    writeFileSync(executable, FAKE_SERVE(true));
    const subject = createOpenCodeProfileService({ home: root, executable, requestTimeoutMs: 200 });

    expect((await verified(subject, profile({ dataRoot }))).signIns).toEqual([
      { service: CONSOLE, method: 'console', email: 'work@example.com' },
    ]);
  });
});
