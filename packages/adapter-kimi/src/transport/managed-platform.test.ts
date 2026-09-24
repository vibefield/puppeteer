import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KIMI_CODE_DEFAULT_BASE_URL,
  KIMI_CODE_GLOBAL_BASE_URL,
  getKimiCodeDocument,
  kimiCodeCredentialFrom,
  kimiCodeCredentialPath,
  readKimiCodeCredential,
  resolveKimiCodeBaseUrl,
} from './managed-platform.js';

const NOW_MS = Date.parse('2026-09-23T12:00:00.000Z');
const NOW_S = NOW_MS / 1_000;
const ACCESS = 'kimi-access-7f3a9c';
const REFRESH = 'kimi-refresh-91bd4e';
const ME_URL = `${KIMI_CODE_DEFAULT_BASE_URL}/me`;

const tempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), 'puppeteer-kimi-platform-'));

/** The table Kimi Code writes for a managed login, with the oauth sub-table after it. */
const managedConfig = (baseUrl: string): string =>
  [
    'default_model = "managed:kimi-code/kimi-for-coding"',
    '',
    '[providers."managed:kimi-code"]',
    'type = "kimi"',
    `base_url = "${baseUrl}"`,
    '',
    '[providers."managed:kimi-code".oauth]',
    'storage = "file"',
    'key = "oauth/kimi-code"',
    '',
  ].join('\n');

describe('Kimi Code credential', () => {
  it('yields a fresh access token and nothing of the refresh token', () => {
    const credential = kimiCodeCredentialFrom(
      {
        access_token: ACCESS,
        refresh_token: REFRESH,
        expires_at: NOW_S + 900,
        expires_in: 900,
        scope: 'kimi-code',
        token_type: 'Bearer',
      },
      NOW_MS,
    );
    expect(credential).toEqual({ state: 'fresh', accessToken: ACCESS });
    expect(JSON.stringify(credential)).not.toContain(REFRESH);
  });

  it('calls a token past expires_at expired, in seconds or milliseconds and within the skew', () => {
    const lapsed = (expiresAt: number) =>
      kimiCodeCredentialFrom({ access_token: ACCESS, refresh_token: REFRESH, expires_at: expiresAt }, NOW_MS);
    expect(lapsed(NOW_S - 35 * 86_400)).toEqual({ state: 'expired' });
    expect(lapsed(NOW_MS - 1)).toEqual({ state: 'expired' });
    expect(lapsed(NOW_S + 30)).toEqual({ state: 'expired' });
    // A missing access token beside a refresh token also waits for Kimi Code.
    expect(kimiCodeCredentialFrom({ access_token: '', refresh_token: REFRESH }, NOW_MS)).toEqual({ state: 'expired' });
  });

  it('reads blank tokens as signed out, the shape a failed refresh leaves', () => {
    expect(
      kimiCodeCredentialFrom(
        {
          access_token: '',
          refresh_token: '',
          expires_at: 0,
          expires_in: 0,
          scope: 'kimi-code',
          token_type: 'Bearer',
        },
        NOW_MS,
      ),
    ).toEqual({ state: 'signed-out' });
    expect(kimiCodeCredentialFrom({}, NOW_MS)).toEqual({ state: 'signed-out' });
  });

  it('keeps a token with no stated expiry and tolerates camelCase', () => {
    expect(kimiCodeCredentialFrom({ access_token: ACCESS }, NOW_MS)).toEqual({ state: 'fresh', accessToken: ACCESS });
    expect(kimiCodeCredentialFrom({ accessToken: ACCESS, expiresAt: NOW_S + 900 }, NOW_MS)).toEqual({
      state: 'fresh',
      accessToken: ACCESS,
    });
  });

  it('calls a document that is not an object unreadable', () => {
    expect(kimiCodeCredentialFrom(null, NOW_MS)).toEqual({ state: 'unreadable' });
    expect(kimiCodeCredentialFrom([ACCESS], NOW_MS)).toEqual({ state: 'unreadable' });
  });

  it('reads a missing file as signed out and a corrupt one as unreadable, without echoing it', async () => {
    const root = await tempRoot();
    expect(await readKimiCodeCredential(kimiCodeCredentialPath(root), NOW_MS)).toEqual({ state: 'signed-out' });
    await mkdir(join(root, 'credentials'));
    await writeFile(kimiCodeCredentialPath(root), `{"access_token":"${ACCESS}"`, 'utf8');
    const corrupt = await readKimiCodeCredential(kimiCodeCredentialPath(root), NOW_MS);
    expect(corrupt).toEqual({ state: 'unreadable' });
    expect(JSON.stringify(corrupt)).not.toContain(ACCESS);
  });

  it('calls a path it cannot read as a file unreadable rather than signed out', async () => {
    const root = await tempRoot();
    await mkdir(kimiCodeCredentialPath(root), { recursive: true });
    expect(await readKimiCodeCredential(kimiCodeCredentialPath(root), NOW_MS)).toEqual({ state: 'unreadable' });
  });
});

describe('Kimi Code platform resolution', () => {
  it('defaults to the mainland platform', async () => {
    expect(await resolveKimiCodeBaseUrl(await tempRoot(), {})).toBe(KIMI_CODE_DEFAULT_BASE_URL);
  });

  it('takes KIMI_CODE_BASE_URL first, without trailing slashes', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'config.toml'), managedConfig(KIMI_CODE_GLOBAL_BASE_URL));
    await writeFile(join(root, 'region'), 'global\n');
    expect(await resolveKimiCodeBaseUrl(root, { KIMI_CODE_BASE_URL: 'https://proxy.example/coding/v1//' })).toBe(
      'https://proxy.example/coding/v1',
    );
    expect(await resolveKimiCodeBaseUrl(root, { KIMI_CODE_BASE_URL: '  ' })).toBe(KIMI_CODE_GLOBAL_BASE_URL);
  });

  it("follows the managed provider's base_url over the region marker", async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'config.toml'), managedConfig('https://API.kimi.ai/coding/v1/'));
    await writeFile(join(root, 'region'), 'mainland-cn\n');
    expect(await resolveKimiCodeBaseUrl(root, {})).toBe(KIMI_CODE_GLOBAL_BASE_URL);
  });

  it('never sends the token to a configured URL that names no managed platform', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'config.toml'), managedConfig('https://collector.example/coding/v1'));
    expect(await resolveKimiCodeBaseUrl(root, {})).toBe(KIMI_CODE_DEFAULT_BASE_URL);
    await writeFile(join(root, 'region'), 'global');
    expect(await resolveKimiCodeBaseUrl(root, {})).toBe(KIMI_CODE_GLOBAL_BASE_URL);
  });

  it('reads base_url only from the managed provider table itself', async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, 'config.toml'),
      [
        '[providers.moonshot]',
        `base_url = "${KIMI_CODE_GLOBAL_BASE_URL}"`,
        '[providers."managed:kimi-code".oauth]',
        `base_url = "${KIMI_CODE_GLOBAL_BASE_URL}"`,
      ].join('\n'),
    );
    expect(await resolveKimiCodeBaseUrl(root, {})).toBe(KIMI_CODE_DEFAULT_BASE_URL);
    await writeFile(
      join(root, 'config.toml'),
      `[ providers . 'managed:kimi-code' ] # login\r\nbase_url = '${KIMI_CODE_GLOBAL_BASE_URL}' # region\r\n`,
    );
    expect(await resolveKimiCodeBaseUrl(root, {})).toBe(KIMI_CODE_GLOBAL_BASE_URL);
  });

  it('maps the region marker, and nothing else it might hold', async () => {
    const cases: Array<[string, string]> = [
      ['cn', KIMI_CODE_DEFAULT_BASE_URL],
      ['mainland-cn\n', KIMI_CODE_DEFAULT_BASE_URL],
      ['global', KIMI_CODE_GLOBAL_BASE_URL],
      ['GLOBAL\n', KIMI_CODE_GLOBAL_BASE_URL],
      ['mars', KIMI_CODE_DEFAULT_BASE_URL],
      ['constructor', KIMI_CODE_DEFAULT_BASE_URL],
    ];
    for (const [marker, expected] of cases) {
      const root = await tempRoot();
      await writeFile(join(root, 'region'), marker);
      expect(await resolveKimiCodeBaseUrl(root, {})).toBe(expected);
    }
  });
});

describe('Kimi Code platform request', () => {
  it('sends the bearer token and Accept, nothing more, and returns the parsed document', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const response = await getKimiCodeDocument(ME_URL, ACCESS, {
      timeoutMs: 1_000,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response('{"user_id":"u_1"}', { status: 200 });
      },
    });
    expect(response).toEqual({ status: 'ok', body: { user_id: 'u_1' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.kimi.com/coding/v1/me');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(Object.fromEntries(new Headers(calls[0]?.init?.headers).entries())).toEqual({
      accept: 'application/json',
      authorization: `Bearer ${ACCESS}`,
    });
    expect(JSON.stringify(response)).not.toContain(ACCESS);
  });

  it('reports a refusal by its status and never reads the body', async () => {
    const refused = await getKimiCodeDocument(ME_URL, ACCESS, {
      timeoutMs: 1_000,
      fetchImpl: async () => new Response(`invalid_authentication_error for ${ACCESS}`, { status: 401 }),
    });
    expect(refused).toEqual({ status: 'http-error', httpStatus: 401 });
    const limited = await getKimiCodeDocument(ME_URL, ACCESS, {
      timeoutMs: 1_000,
      fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '30' } }),
    });
    expect(limited).toEqual({ status: 'http-error', httpStatus: 429, retryAfter: '30' });
  });

  it('tells a body that is not JSON from no answer at all', async () => {
    expect(
      await getKimiCodeDocument(ME_URL, ACCESS, {
        timeoutMs: 1_000,
        fetchImpl: async () => new Response('<html>', { status: 200 }),
      }),
    ).toEqual({ status: 'invalid-json' });
    expect(
      await getKimiCodeDocument(ME_URL, ACCESS, {
        timeoutMs: 1_000,
        fetchImpl: async () => {
          throw new TypeError(`fetch failed for ${ACCESS}`);
        },
      }),
    ).toEqual({ status: 'failed' });
  });

  it('gives up when the platform does not answer in time', async () => {
    const response = await getKimiCodeDocument(ME_URL, ACCESS, {
      timeoutMs: 10,
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    });
    expect(response).toEqual({ status: 'failed' });
  });
});
