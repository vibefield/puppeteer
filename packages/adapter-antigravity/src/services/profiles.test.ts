import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentProfileSchema,
  ProfileFailureSchema,
  ProfileIdentitySchema,
  ProfileProviderSchema,
  type AgentProfile,
} from '@vibefield/puppeteer-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANTIGRAVITY_PROFILE_ROOT_VARIABLE, createAntigravityProfileService } from './profiles.js';

const service = createAntigravityProfileService({ home: '/home/tester', executable: 'agy', env: {} });

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile =>
  AgentProfileSchema.parse({
    id: 'antigravity:0b12ce77',
    provider: 'antigravity',
    label: 'Work',
    kind: 'managed',
    dataRoot: '/home/tester/.puppeteer/profiles/antigravity/0b12ce77',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

describe('Antigravity profiles', () => {
  it('declares a Google sign-in whose credential lives in the bound home', () => {
    expect(() => ProfileProviderSchema.parse(service.provider)).not.toThrow();
    expect(service.provider.support).toEqual({
      supported: true,
      identity: 'native-status',
      sharedSurfaces: [],
      nativeDefaultRoot: '/home/tester/.gemini/antigravity-cli',
      credential: 'root',
      service: { id: 'google', label: 'Google' },
    });
  });

  it('offers no native sign-out, because /logout purges the keyring every home shares', () => {
    expect(service.signOut).toBeUndefined();
  });

  it('binds a managed home through the adapter-owned home redirection', () => {
    expect(service.bindingEnvironment(profile())).toEqual({
      [ANTIGRAVITY_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/antigravity/0b12ce77',
    });
  });

  it('injects nothing for the native default profile', () => {
    expect(
      service.bindingEnvironment(profile({ kind: 'native-default', dataRoot: '/home/tester/.gemini/antigravity-cli' })),
    ).toEqual({});
  });

  it('names the store inside the home as the history layout root for an indexer', () => {
    expect(service.observationRoot(profile())).toBe(
      '/home/tester/.puppeteer/profiles/antigravity/0b12ce77/.gemini/antigravity-cli',
    );
    expect(
      service.observationRoot(profile({ kind: 'native-default', dataRoot: '/home/tester/.gemini/antigravity-cli' })),
    ).toBe('/home/tester/.gemini/antigravity-cli');
  });

  it('opens the agent itself under the profile home, because no login subcommand exists', () => {
    expect(service.loginInvocation(profile(), { cwd: '/work/repo' })).toEqual({
      command: 'agy',
      args: [],
      cwd: '/work/repo',
      env: {
        HOME: '/home/tester/.puppeteer/profiles/antigravity/0b12ce77',
        [ANTIGRAVITY_PROFILE_ROOT_VARIABLE]: '/home/tester/.puppeteer/profiles/antigravity/0b12ce77',
      },
    });
    expect(
      service.loginInvocation(profile({ kind: 'native-default', dataRoot: '/home/tester/.gemini/antigravity-cli' }), {
        cwd: '/work/repo',
      }).env,
    ).toEqual({});
  });
});

// Invented for these tests: the 1.2.9 file's layout, none of its values.
const ACCESS_TOKEN = 'ya29.fake-access-token-for-antigravity-profile-tests';
const REFRESH_TOKEN = '1//fake-refresh-token-for-antigravity-profile-tests';
const SUBJECT = '109876543210987654321';
const NAME = 'Test Person';
const NOW = new Date('2026-09-23T12:00:00.000Z');
const SOURCE = { kind: 'native-status', stability: 'experimental' };
/** What every base64url JSON segment starts with: no part of an ID token may leave the file. */
const JWT_SEGMENT = 'eyJ';

const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A Google-shaped ID token with invented claims and a signature nobody checks. */
function fakeIdToken(claims: Record<string, unknown>): string {
  return [
    segment({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }),
    segment({
      iss: 'https://accounts.google.com',
      aud: 'test-client.apps.googleusercontent.com',
      sub: SUBJECT,
      name: NAME,
      email_verified: true,
      iat: 1_790_164_800,
      exp: 1_790_168_400,
      ...claims,
    }),
    Buffer.from('not-a-signature').toString('base64url'),
  ].join('.');
}

function credentialFile(fields: { claims?: Record<string, unknown>; authMethod?: unknown; idToken?: unknown }): string {
  return JSON.stringify({
    token: {
      access_token: ACCESS_TOKEN,
      token_type: 'Bearer',
      refresh_token: REFRESH_TOKEN,
      expiry: '2026-09-23T13:00:00Z',
    },
    auth_method: 'authMethod' in fields ? fields.authMethod : 'consumer',
    id_token: 'idToken' in fields ? fields.idToken : fakeIdToken(fields.claims ?? {}),
  });
}

describe('Antigravity profile verification', () => {
  let home: string;
  let managedHome: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'puppeteer-antigravity-profiles-'));
    managedHome = join(home, '.puppeteer', 'profiles', 'work', 'antigravity-0b12ce77');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const managed = (): AgentProfile => profile({ dataRoot: managedHome });
  const nativeDefault = (): AgentProfile =>
    profile({
      id: 'antigravity:native-default',
      label: 'Default',
      kind: 'native-default',
      dataRoot: join(home, '.gemini', 'antigravity-cli'),
    });

  async function writeStore(homeDirectory: string, file: string, contents: string): Promise<void> {
    const store = join(homeDirectory, '.gemini', 'antigravity-cli');
    await mkdir(store, { recursive: true });
    await writeFile(join(store, file), contents, { mode: 0o600 });
  }

  /** verify(), held to the Core schemas and to leaking nothing the file carries beside email and hd. */
  async function verify(target: AgentProfile, env: NodeJS.ProcessEnv = {}) {
    const result = await createAntigravityProfileService({ home, executable: 'agy', env, now: () => NOW }).verify(
      target,
    );
    if ('status' in result) ProfileFailureSchema.parse(result);
    else ProfileIdentitySchema.parse(result);
    const serialized = JSON.stringify(result);
    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, SUBJECT, NAME, JWT_SEGMENT]) {
      expect(serialized).not.toContain(secret);
    }
    return result;
  }

  const unavailable = (message: string) => ({
    status: 'unavailable',
    provider: 'antigravity',
    message,
    retryable: true,
  });

  it('reads the consumer account from the credential file in a managed home', async () => {
    await writeStore(
      managedHome,
      'antigravity-oauth-token',
      credentialFile({ claims: { email: 'person@example.com' } }),
    );
    await expect(verify(managed())).resolves.toEqual({
      loggedIn: true,
      method: 'consumer',
      email: 'person@example.com',
      verifiedAt: NOW.toISOString(),
      source: SOURCE,
    });
  });

  it('names the hosted domain as the organization when the ID token carries one', async () => {
    await writeStore(
      managedHome,
      'antigravity-oauth-token',
      credentialFile({ claims: { email: 'person@example.com', hd: 'example.com' } }),
    );
    await expect(verify(managed())).resolves.toMatchObject({
      loggedIn: true,
      email: 'person@example.com',
      organization: 'example.com',
    });
  });

  it('keeps auth_method only as a short label', async () => {
    const claims = { email: 'person@example.com' };
    for (const authMethod of ['x'.repeat(200), 'consumer; rm -rf', 42, null]) {
      await writeStore(managedHome, 'antigravity-oauth-token', credentialFile({ claims, authMethod }));
      const result = await verify(managed());
      expect(result).toMatchObject({ loggedIn: true, email: 'person@example.com' });
      expect(result).not.toHaveProperty('method');
    }
  });

  it('reads signed out when the home holds no credential file', async () => {
    await expect(verify(managed())).resolves.toEqual({
      loggedIn: false,
      verifiedAt: NOW.toISOString(),
      source: SOURCE,
    });
    await writeStore(managedHome, 'settings.json', JSON.stringify({ trustedWorkspaces: ['/work/repo'] }));
    await expect(verify(managed())).resolves.toMatchObject({ loggedIn: false });
  });

  it('fails as unavailable, never signed out, on a credential file it cannot read', async () => {
    await mkdir(join(managedHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), { recursive: true });
    await expect(verify(managed())).resolves.toEqual(unavailable('the Antigravity credential file could not be read'));
  });

  it('fails as unavailable on a credential file that is not JSON, without quoting it', async () => {
    // An unquoted token is a case V8's message quotes: `Unexpected token 'y', ..."ss_token":ya29.fake-"...`.
    const corrupt = credentialFile({ claims: { email: 'person@example.com' } }).replace(
      `"${ACCESS_TOKEN}"`,
      ACCESS_TOKEN,
    );
    await writeStore(managedHome, 'antigravity-oauth-token', corrupt);
    const result = await verify(managed());
    expect(result).toEqual(unavailable('the Antigravity credential file is not JSON'));
    expect(JSON.stringify(result)).not.toContain('ya29');
  });

  it('fails as unavailable when the ID token names no account', async () => {
    const cases = [
      credentialFile({ claims: {} }),
      credentialFile({ claims: { email: 'not-an-address' } }),
      credentialFile({ claims: { email: ['person@example.com'] } }),
      credentialFile({ idToken: 'opaque-token' }),
      credentialFile({ idToken: undefined }),
      JSON.stringify([]),
    ];
    for (const contents of cases) {
      await writeStore(managedHome, 'antigravity-oauth-token', contents);
      await expect(verify(managed())).resolves.toEqual(unavailable('the Antigravity credential file names no account'));
    }
  });

  it('reads a Gemini API key root as signed out, never as the consumer account beside it', async () => {
    await writeStore(
      managedHome,
      'antigravity-oauth-token',
      credentialFile({ claims: { email: 'person@example.com' } }),
    );
    await writeStore(managedHome, 'settings.json', JSON.stringify({ modelProvider: 'gemini' }));
    await expect(verify(managed(), { GEMINI_API_KEY: 'AIza-fake-key-for-tests' })).resolves.toEqual({
      loggedIn: false,
      method: 'gemini-api-key',
      verifiedAt: NOW.toISOString(),
      source: SOURCE,
    });
  });

  it('reads an ADC environment as signed out, never as the consumer account in the home', async () => {
    await writeStore(
      managedHome,
      'antigravity-oauth-token',
      credentialFile({ claims: { email: 'person@example.com' } }),
    );
    await expect(verify(managed(), { AGY_ADC_AUTH: 'true' })).resolves.toEqual({
      loggedIn: false,
      method: 'adc',
      verifiedAt: NOW.toISOString(),
      source: SOURCE,
    });
    for (const off of ['', 'false', '0']) {
      await expect(verify(managed(), { AGY_ADC_AUTH: off })).resolves.toMatchObject({
        loggedIn: true,
        email: 'person@example.com',
      });
    }
  });

  it('reads no environment variable but the ADC switch, and never GEMINI_API_KEY', async () => {
    await writeStore(
      managedHome,
      'antigravity-oauth-token',
      credentialFile({ claims: { email: 'person@example.com' } }),
    );
    const read: string[] = [];
    const env = new Proxy<NodeJS.ProcessEnv>(
      { GEMINI_API_KEY: 'AIza-fake-key-for-tests', [ANTIGRAVITY_PROFILE_ROOT_VARIABLE]: '/elsewhere' },
      {
        get(target, key, receiver) {
          if (typeof key === 'string') read.push(key);
          return Reflect.get(target, key, receiver);
        },
      },
    );
    await expect(verify(managed(), env)).resolves.toMatchObject({ loggedIn: true });
    await expect(verify(nativeDefault(), env)).resolves.toMatchObject({ loggedIn: false });
    expect([...new Set(read)]).toEqual(['AGY_ADC_AUTH']);
  });

  it('refuses to guess at settings it cannot read or a model provider it does not know', async () => {
    await writeStore(
      managedHome,
      'antigravity-oauth-token',
      credentialFile({ claims: { email: 'person@example.com' } }),
    );
    await writeStore(managedHome, 'settings.json', '{ "modelProvider": ');
    await expect(verify(managed())).resolves.toEqual(unavailable('Antigravity settings.json could not be read'));
    await writeStore(managedHome, 'settings.json', '[]');
    await expect(verify(managed())).resolves.toEqual(unavailable('Antigravity settings.json is not a settings object'));
    await writeStore(managedHome, 'settings.json', JSON.stringify({ modelProvider: 'vertex' }));
    await expect(verify(managed())).resolves.toEqual(
      unavailable('Antigravity settings.json names an unknown model provider'),
    );
  });

  it('resolves the home the way launch does, whatever root variable the host inherited', async () => {
    await writeStore(home, 'antigravity-oauth-token', credentialFile({ claims: { email: 'native@example.com' } }));
    await writeStore(managedHome, 'antigravity-oauth-token', credentialFile({ claims: { email: 'work@example.com' } }));
    await expect(verify(nativeDefault())).resolves.toMatchObject({ email: 'native@example.com' });
    await expect(verify(managed())).resolves.toMatchObject({ email: 'work@example.com' });
    await expect(verify(nativeDefault(), { [ANTIGRAVITY_PROFILE_ROOT_VARIABLE]: managedHome })).resolves.toMatchObject({
      email: 'native@example.com',
    });
  });
});
