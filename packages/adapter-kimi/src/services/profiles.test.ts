import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AgentProfileSchema,
  ProfileIdentitySchema,
  ProfileProviderSchema,
  type AgentProfile,
} from '@vibefield/puppeteer-core';
import { describe, expect, it } from 'vitest';
import {
  createKimiProfileService,
  KIMI_PROFILE_ROOT_VARIABLE,
  kimiCredentialRoot,
  kimiProfileIdentityFrom,
  type KimiProfileServiceOptions,
} from './profiles.js';

const service = createKimiProfileService({ home: resolve('/home/tester'), executable: 'kimi', env: {} });

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile =>
  AgentProfileSchema.parse({
    id: 'kimi:1d0f77aa',
    provider: 'kimi',
    label: 'Personal',
    kind: 'managed',
    dataRoot: resolve('/home/tester/.puppeteer/profiles/kimi/1d0f77aa'),
    createdAt: new Date().toISOString(),
    ...overrides,
  });

describe('Kimi profiles', () => {
  it('declares a native-status identity, a credential inside the root, and the Kimi service', () => {
    expect(() => ProfileProviderSchema.parse(service.provider)).not.toThrow();
    expect(service.provider).toEqual({
      id: 'kimi',
      label: 'Kimi',
      support: {
        supported: true,
        identity: 'native-status',
        sharedSurfaces: [],
        nativeDefaultRoot: resolve('/home/tester/.kimi-code'),
        credential: 'root',
        service: { id: 'kimi', label: 'Moonshot AI' },
      },
    });
    // Deleting a managed root is the sign-out; there is no vendor command to run.
    expect(service.signOut).toBeUndefined();
  });

  it('binds a managed profile through the native root variable', () => {
    expect(service.bindingEnvironment(profile())).toEqual({
      [KIMI_PROFILE_ROOT_VARIABLE]: resolve('/home/tester/.puppeteer/profiles/kimi/1d0f77aa'),
    });
  });

  it('injects nothing for the native default profile', () => {
    expect(
      service.bindingEnvironment(profile({ kind: 'native-default', dataRoot: resolve('/home/tester/.kimi-code') })),
    ).toEqual({});
  });

  it('names the history layout root for an indexer', () => {
    expect(service.observationRoot(profile())).toBe(resolve('/home/tester/.puppeteer/profiles/kimi/1d0f77aa'));
    expect(
      service.observationRoot(profile({ kind: 'native-default', dataRoot: resolve('/home/tester/.kimi-code') })),
    ).toBe(resolve('/home/tester/.kimi-code'));
  });

  it('runs the native device-code login inside the profile binding', () => {
    expect(service.loginInvocation(profile(), { cwd: resolve('/work/repo') })).toEqual({
      command: 'kimi',
      args: ['login'],
      cwd: resolve('/work/repo'),
      env: { [KIMI_PROFILE_ROOT_VARIABLE]: resolve('/home/tester/.puppeteer/profiles/kimi/1d0f77aa') },
    });
  });
});

const NOW = new Date('2026-09-23T12:00:00.000Z');
const ACCESS = 'kimi-access-7f3a9c';
const REFRESH = 'kimi-refresh-91bd4e';
const SOURCE = { kind: 'native-status', stability: 'documented' } as const;

/** Kimi Code's token file as it writes one; the access token lives fifteen minutes. */
const credential = (expiresAt = NOW.valueOf() / 1_000 + 900) => ({
  access_token: ACCESS,
  refresh_token: REFRESH,
  expires_at: expiresAt,
  expires_in: 900,
  scope: 'kimi-code',
  token_type: 'Bearer',
});

/** The `/me` document in the shape the CLI's own parser documents, private fields and all. */
const ME = {
  user_id: 'u_5c1e0b',
  nickname: 'moonwalker',
  status: 'USER_STATUS_NORMAL',
  region: 'REGION_CN',
  user_level: 30,
  user_level_name: 'Vivace',
  domain: 1,
  domain_name: 'DOMAIN_EXAMPLE',
  goods_version: 1,
  global_id: 'g_77aa01',
  avatar: 'https://example.com/avatar-9f2.png',
  bio: 'writes compilers at night',
  username: 'moonwalker_cn',
  email: 'dev@example.com',
  phone: { country_code: '86', number: '176****0000' },
  created_time: '2026-06-11T13:26:47.561184Z',
  last_login_time: '2026-07-16T03:12:03.033412Z',
};

/** Nothing secret or personal beyond the email and plan may reach a result. */
const WITHHELD = [
  ACCESS,
  REFRESH,
  ME.user_id,
  ME.nickname,
  ME.global_id,
  ME.avatar,
  ME.bio,
  ME.username,
  ME.phone.number,
  ME.domain_name,
  ME.region,
];

function expectWithheld(result: unknown): void {
  const serialized = JSON.stringify(result);
  for (const value of WITHHELD) expect(serialized).not.toContain(value);
}

const tempDirectory = (): Promise<string> => mkdtemp(join(tmpdir(), 'puppeteer-kimi-profile-'));

async function writeCredential(root: string, document: unknown): Promise<void> {
  await mkdir(join(root, 'credentials'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'credentials', 'kimi-code.json'), JSON.stringify(document), { mode: 0o600 });
}

/** Every file under a root with its bytes and mode, to prove verification wrote nothing. */
async function contents(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    const path = join(root, name);
    const info = await stat(path);
    if (info.isFile()) files[name] = `${info.mode.toString(8)} ${await readFile(path, 'utf8')}`;
  }
  return files;
}

interface PlatformCall {
  url: string;
  headers: Headers;
}

/** A scripted platform that records every request it receives. */
function platform(answer: () => Response | Promise<Response> = () => Response.json(ME)): {
  calls: PlatformCall[];
  fetchImpl: typeof fetch;
} {
  const calls: PlatformCall[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return answer();
    },
  };
}

function verifier(fake: ReturnType<typeof platform>, overrides: KimiProfileServiceOptions = {}) {
  return createKimiProfileService({
    home: '/nonexistent/kimi-test-home',
    executable: 'kimi',
    env: {},
    now: () => NOW,
    fetchImpl: fake.fetchImpl,
    ...overrides,
  });
}

async function managedProfile(): Promise<AgentProfile> {
  return profile({ dataRoot: await tempDirectory() });
}

describe('Kimi profile verification', () => {
  it('reads who is signed in from GET /me with the access token the root already holds', async () => {
    const managed = await managedProfile();
    await writeCredential(managed.dataRoot, credential());
    const before = await contents(managed.dataRoot);
    const fake = platform();

    const identity = await verifier(fake).verify(managed);

    expect(identity).toEqual({
      loggedIn: true,
      method: 'kimi-code',
      email: 'dev@example.com',
      plan: 'Vivace',
      verifiedAt: NOW.toISOString(),
      source: SOURCE,
    });
    expect(() => ProfileIdentitySchema.parse(identity)).not.toThrow();
    expect(fake.calls.map(({ url }) => url)).toEqual(['https://api.kimi.com/coding/v1/me']);
    expect(Object.fromEntries(fake.calls[0]!.headers.entries())).toEqual({
      accept: 'application/json',
      authorization: `Bearer ${ACCESS}`,
    });
    expectWithheld(identity);
    expect(await contents(managed.dataRoot)).toEqual(before);
  });

  it('leaves out an email and a plan the document does not fill', async () => {
    const managed = await managedProfile();
    await writeCredential(managed.dataRoot, credential());
    const identity = await verifier(platform(() => Response.json({ ...ME, email: '', user_level_name: ' ' }))).verify(
      managed,
    );
    expect(identity).toEqual({ loggedIn: true, method: 'kimi-code', verifiedAt: NOW.toISOString(), source: SOURCE });
  });

  it('reads a root without a credential file as signed out, without calling the platform', async () => {
    const fake = platform();
    expect(await verifier(fake).verify(await managedProfile())).toEqual({
      loggedIn: false,
      verifiedAt: NOW.toISOString(),
      source: SOURCE,
    });
    expect(fake.calls).toEqual([]);
  });

  it('reads blank tokens as signed out: what a failed refresh leaves behind', async () => {
    const managed = await managedProfile();
    await writeCredential(managed.dataRoot, {
      access_token: '',
      refresh_token: '',
      expires_at: 0,
      expires_in: 0,
      scope: 'kimi-code',
      token_type: 'Bearer',
    });
    const fake = platform();
    expect(await verifier(fake).verify(managed)).toEqual({
      loggedIn: false,
      verifiedAt: NOW.toISOString(),
      source: SOURCE,
    });
    expect(fake.calls).toEqual([]);
  });

  it('leaves a lapsed access token for Kimi Code to renew: no call, no refresh, no write', async () => {
    const managed = await managedProfile();
    await writeCredential(managed.dataRoot, credential(NOW.valueOf() / 1_000 - 35 * 86_400));
    const before = await contents(managed.dataRoot);
    const fake = platform();

    const result = await verifier(fake).verify(managed);

    expect(result).toMatchObject({ status: 'unavailable', provider: 'kimi', retryable: true });
    expect(fake.calls).toEqual([]);
    expect(await contents(managed.dataRoot)).toEqual(before);
    expectWithheld(result);
  });

  it('never reads a rejected token or a failed request as a signed-out root', async () => {
    const answers: Array<() => Response | Promise<Response>> = [
      () => new Response(`{"error":{"type":"invalid_authentication_error","token":"${ACCESS}"}}`, { status: 401 }),
      () => new Response('', { status: 402 }),
      () => new Response('', { status: 500 }),
      () => Promise.reject(new TypeError('fetch failed')),
    ];
    for (const answer of answers) {
      const managed = await managedProfile();
      await writeCredential(managed.dataRoot, credential());
      const before = await contents(managed.dataRoot);
      const fake = platform(answer);
      const result = await verifier(fake).verify(managed);
      expect(result).toMatchObject({ status: 'unavailable', provider: 'kimi', retryable: true });
      expect(fake.calls).toHaveLength(1);
      expect(await contents(managed.dataRoot)).toEqual(before);
      expectWithheld(result);
    }
  });

  it('treats a document without a string user_id as malformed, not signed out', async () => {
    const answers: Array<() => Response> = [
      () => Response.json({ nickname: ME.nickname, email: ME.email }),
      () => Response.json({ ...ME, user_id: 42 }),
      () => Response.json({ ...ME, user_id: '' }),
      () => Response.json([ME]),
      () => new Response('<html>maintenance</html>', { status: 200 }),
    ];
    for (const answer of answers) {
      const managed = await managedProfile();
      await writeCredential(managed.dataRoot, credential());
      const result = await verifier(platform(answer)).verify(managed);
      expect(result).toMatchObject({ status: 'unavailable', provider: 'kimi', retryable: true });
      expectWithheld(result);
    }
  });

  it('calls a credential file it cannot decode unreadable rather than signed out', async () => {
    const managed = await managedProfile();
    await mkdir(join(managed.dataRoot, 'credentials'), { recursive: true });
    await writeFile(join(managed.dataRoot, 'credentials', 'kimi-code.json'), `{"access_token":"${ACCESS}"`);
    const fake = platform();
    const result = await verifier(fake).verify(managed);
    expect(result).toMatchObject({ status: 'unavailable', provider: 'kimi' });
    expect(fake.calls).toEqual([]);
    expectWithheld(result);
  });
});

describe('Kimi profile platform', () => {
  it('asks the platform KIMI_CODE_BASE_URL names before anything the root says', async () => {
    const managed = await managedProfile();
    await writeCredential(managed.dataRoot, credential());
    await writeFile(
      join(managed.dataRoot, 'config.toml'),
      '[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.ai/coding/v1"\n',
    );
    const fake = platform();
    await verifier(fake, { env: { KIMI_CODE_BASE_URL: 'https://proxy.example/coding/v1/' } }).verify(managed);
    expect(fake.calls.map(({ url }) => url)).toEqual(['https://proxy.example/coding/v1/me']);
  });

  it('asks the global platform a root was configured for at login', async () => {
    const managed = await managedProfile();
    await writeCredential(managed.dataRoot, credential());
    await writeFile(
      join(managed.dataRoot, 'config.toml'),
      [
        '[providers."managed:kimi-code"]',
        'type = "kimi"',
        'base_url = "https://api.kimi.ai/coding/v1"',
        '',
        '[providers."managed:kimi-code".oauth]',
        'storage = "file"',
        'key = "oauth/kimi-code"',
      ].join('\n'),
    );
    const fake = platform();
    expect(await verifier(fake).verify(managed)).toMatchObject({ loggedIn: true, email: 'dev@example.com' });
    expect(fake.calls.map(({ url }) => url)).toEqual(['https://api.kimi.ai/coding/v1/me']);
  });

  it("falls back to the root's region marker, then to the mainland platform", async () => {
    const cases: Array<[string | undefined, string]> = [
      ['global\n', 'https://api.kimi.ai/coding/v1/me'],
      ['cn\n', 'https://api.kimi.com/coding/v1/me'],
      [undefined, 'https://api.kimi.com/coding/v1/me'],
    ];
    for (const [region, url] of cases) {
      const managed = await managedProfile();
      await writeCredential(managed.dataRoot, credential());
      await writeFile(
        join(managed.dataRoot, 'config.toml'),
        '[providers."managed:kimi-code"]\nbase_url = "https://collector.example/coding/v1"\n',
      );
      if (region !== undefined) await writeFile(join(managed.dataRoot, 'region'), region);
      const fake = platform();
      await verifier(fake).verify(managed);
      expect(fake.calls.map((call) => call.url)).toEqual([url]);
    }
  });
});

describe('Kimi profile roots', () => {
  it('verifies the native default in ~/.kimi-code under the injected home', async () => {
    const home = await tempDirectory();
    await writeCredential(join(home, '.kimi-code'), credential());
    const nativeDefault = profile({
      id: 'kimi:native-default',
      kind: 'native-default',
      dataRoot: join(home, '.kimi-code'),
    });
    const fake = platform();
    expect(await verifier(fake, { home }).verify(nativeDefault)).toMatchObject({ loggedIn: true, plan: 'Vivace' });
    expect(fake.calls).toHaveLength(1);
  });

  it('follows KIMI_CODE_HOME for the native default, as Kimi Code itself does', async () => {
    const home = await tempDirectory();
    const nativeDefault = profile({
      id: 'kimi:native-default',
      kind: 'native-default',
      dataRoot: join(home, '.kimi-code'),
    });
    await writeCredential(join(home, 'alternate'), credential());
    const fake = platform();
    expect(await verifier(fake, { home, env: { KIMI_CODE_HOME: '~/alternate' } }).verify(nativeDefault)).toMatchObject({
      loggedIn: true,
    });
    expect(fake.calls).toHaveLength(1);
    expect(kimiCredentialRoot(nativeDefault, { KIMI_CODE_HOME: '/opt/kimi' }, home)).toBe('/opt/kimi');
    expect(kimiCredentialRoot(nativeDefault, { KIMI_CODE_HOME: '~' }, home)).toBe(home);
    expect(kimiCredentialRoot(undefined, {}, home)).toBe(join(home, '.kimi-code'));
  });

  it('keeps a managed profile on its own root whatever KIMI_CODE_HOME says', async () => {
    const elsewhere = await tempDirectory();
    await writeCredential(elsewhere, credential());
    const managed = await managedProfile();
    const fake = platform();
    expect(await verifier(fake, { env: { KIMI_CODE_HOME: elsewhere } }).verify(managed)).toMatchObject({
      loggedIn: false,
    });
    expect(fake.calls).toEqual([]);
    expect(kimiCredentialRoot(managed, { KIMI_CODE_HOME: elsewhere })).toBe(managed.dataRoot);
  });
});

describe('Kimi /me decoding', () => {
  it('keeps the email and plan and nothing else the document carries', () => {
    const identity = kimiProfileIdentityFrom(ME, NOW.toISOString());
    expect(identity).toEqual({
      loggedIn: true,
      method: 'kimi-code',
      email: 'dev@example.com',
      plan: 'Vivace',
      verifiedAt: NOW.toISOString(),
      source: SOURCE,
    });
    expectWithheld(identity);
  });

  it('never fills an organization from the internal domain code', () => {
    expect(kimiProfileIdentityFrom(ME, NOW.toISOString())).not.toHaveProperty('organization');
  });
});
