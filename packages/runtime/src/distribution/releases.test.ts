import { describe, expect, it, vi } from 'vitest';
import type { AgentInstallation, DistributionProvider, DistributionService } from '@vibefield/puppeteer-core';
import { availableUpdate, checkProviderReleases, compareVersions, createReleaseEtagCache } from './releases.js';

const installed: AgentInstallation = {
  provider: 'example',
  executable: '/usr/local/bin/example',
  realPath: '/usr/local/bin/example',
  version: '1.2.3',
  method: 'standalone-binary',
  autoUpdate: 'unknown',
  detectedAt: '2026-09-06T12:00:00.000Z',
  warnings: [],
  origin: 'path',
  active: true,
};

function provider(overrides: Partial<DistributionProvider> = {}): DistributionProvider {
  return {
    id: 'example',
    label: 'Example',
    commands: ['example'],
    npmPackages: [],
    brewNames: [],
    detectors: [],
    nativeUpdateCheck: false,
    ...overrides,
  };
}

function service(overrides: Partial<DistributionService> = {}): DistributionService {
  return {
    provider: provider(),
    async inspect() {
      return undefined;
    },
    recipeFor: () => ({ kind: 'manual', instructions: 'n/a' }),
    ...overrides,
  };
}

function response(body: string, init: { status?: number; etag?: string } = {}): Response {
  const headers = new Headers();
  if (init.etag) headers.set('etag', init.etag);
  return new Response(init.status === 304 ? null : body, { status: init.status ?? 200, headers });
}

describe('compareVersions', () => {
  it('compares numeric segments across vendor version grammars', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1);
    expect(compareVersions('2.1.263', '2.1.263')).toBe(0);
    expect(compareVersions('v1.0.13', '1.0.9')).toBe(1);
    expect(compareVersions('1.0.80.', '1.0.83')).toBe(-1);
    expect(compareVersions('codex-cli 0.153.4', '0.153.4')).toBe(0);
    // A missing trailing segment reads as zero, not as "newer".
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.1')).toBe(-1);
  });
});

describe('checkProviderReleases', () => {
  it('keeps the network off until the caller asks for it', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await checkProviderReleases({
      provider: provider({
        detectors: [
          {
            kind: 'text',
            id: 'vendor-stable',
            channel: 'stable',
            url: 'https://downloads.example.com/stable',
            versionPattern: '^(\\d+\\.\\d+\\.\\d+)',
          },
        ],
      }),
      service: service(),
      installed,
      network: false,
      fetch: fetchImpl,
      cache: createReleaseEtagCache(),
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ provider: 'example', releases: [], behind: [], failures: [] });
    expect(result.installed?.version).toBe('1.2.3');
  });

  it('prefers the native oracle and reports how far behind the active install is', async () => {
    const checkUpdate = vi.fn(async () => ({
      provider: 'example',
      channel: 'stable' as const,
      version: '1.3.0',
      fetchedAt: '2026-09-06T12:00:00.000Z',
      source: { kind: 'native-oracle' as const, id: 'example update --check --json' },
    }));
    const result = await checkProviderReleases({
      provider: provider({ nativeUpdateCheck: true }),
      service: service({ checkUpdate }),
      installed,
      network: false,
      fetch: vi.fn<typeof fetch>(),
      cache: createReleaseEtagCache(),
    });

    // The oracle receives the classified install, never the host's ranking fields.
    expect(checkUpdate).toHaveBeenCalledWith(expect.not.objectContaining({ active: expect.anything() }));
    expect(result.releases).toHaveLength(1);
    expect(result.behind).toEqual([{ channel: 'stable', version: '1.3.0' }]);
    expect(result.available).toEqual({ channel: 'stable', version: '1.3.0' });
  });

  it('executes text, npm-registry, and github-release detectors', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://downloads.example.com')) return response('1.2.9\n');
      if (url.startsWith('https://registry.npmjs.org')) {
        return response(JSON.stringify({ 'dist-tags': { latest: '1.2.8', next: '2.0.0-rc.1' } }));
      }
      return response(
        JSON.stringify([
          { tag_name: 'v1.2.5', name: 'Example 1.2.5', prerelease: false, published_at: '2026-09-01T00:00:00.000Z' },
          { tag_name: 'v1.4.0', name: 'Example 1.4.0', prerelease: true },
          { tag_name: 'not-a-release', name: 'Example 9.9.9', prerelease: false },
          { tag_name: 'v1.3.1', name: 'Example 1.3.1', prerelease: false, html_url: 'https://example.test/1.3.1' },
        ]),
      );
    }) as unknown as typeof fetch;

    const result = await checkProviderReleases({
      provider: provider({
        detectors: [
          {
            kind: 'text',
            id: 'vendor-stable',
            channel: 'stable',
            url: 'https://downloads.example.com/stable',
            versionPattern: '^(\\d+\\.\\d+\\.\\d+)',
          },
          { kind: 'npm-registry', id: 'npm-latest', channel: 'stable', package: '@example/cli', distTag: 'latest' },
          {
            kind: 'github-release',
            id: 'github-stable',
            channel: 'preview',
            url: 'https://api.github.com/repos/example/cli/releases',
            tagPattern: '^v(.+)$',
            titlePattern: '^Example (\\S+)$',
            prerelease: false,
          },
        ],
      }),
      service: service(),
      installed,
      network: true,
      fetch: fetchImpl,
      cache: createReleaseEtagCache(),
    });

    expect(result.failures).toEqual([]);
    expect(Object.fromEntries(result.releases.map((release) => [release.source.id, release.version]))).toEqual({
      'vendor-stable': '1.2.9',
      'npm-latest': '1.2.8',
      // The prerelease is skipped and the unmatched tag ignored, so 1.3.1 wins.
      'github-stable': '1.3.1',
    });
    expect(result.releases.find((release) => release.source.id === 'github-stable')?.url).toBe(
      'https://example.test/1.3.1',
    );
    expect(result.behind).toEqual([
      { channel: 'stable', version: '1.2.9' },
      { channel: 'preview', version: '1.3.1' },
    ]);
    const npmCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((call) =>
      String(call[0]).startsWith('https://registry.npmjs.org'),
    );
    expect((npmCall?.[1] as RequestInit).headers).toMatchObject({
      accept: 'application/vnd.npm.install-v1+json',
      'user-agent': 'puppeteer-runtime',
    });
  });

  it('revalidates with If-None-Match and reuses the cached body on 304', async () => {
    const cache = createReleaseEtagCache();
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      return headers['if-none-match'] === 'W/"v1"'
        ? response('', { status: 304 })
        : response('1.2.9\n', { etag: 'W/"v1"' });
    }) as unknown as typeof fetch;
    const options = {
      provider: provider({
        detectors: [
          {
            kind: 'text' as const,
            id: 'vendor-stable',
            channel: 'stable' as const,
            url: 'https://downloads.example.com/stable',
            versionPattern: '^(\\d+\\.\\d+\\.\\d+)',
          },
        ],
      }),
      service: service(),
      installed,
      network: true,
      fetch: fetchImpl,
      cache,
    };

    await expect(checkProviderReleases(options)).resolves.toMatchObject({ behind: [{ version: '1.2.9' }] });
    const second = await checkProviderReleases(options);
    expect(second.failures).toEqual([]);
    expect(second.releases[0]?.version).toBe('1.2.9');
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('turns network and oracle faults into typed failures instead of throwing', async () => {
    const onError = vi.fn();
    const result = await checkProviderReleases({
      provider: provider({
        nativeUpdateCheck: true,
        detectors: [
          {
            kind: 'text',
            id: 'vendor-stable',
            channel: 'stable',
            url: 'https://downloads.example.com/stable',
            versionPattern: '^(\\d+\\.\\d+\\.\\d+)',
          },
        ],
      }),
      service: service({
        async checkUpdate() {
          throw new Error('native oracle crashed with token sk-secret');
        },
      }),
      installed,
      network: true,
      fetch: (async () => {
        throw new Error('getaddrinfo ENOTFOUND downloads.example.com');
      }) as unknown as typeof fetch,
      cache: createReleaseEtagCache(),
      onError,
    });

    expect(result.releases).toEqual([]);
    expect(result.behind).toEqual([]);
    expect(result.failures).toEqual([
      { status: 'unavailable', provider: 'example', message: 'native update check failed', retryable: true },
      {
        status: 'unavailable',
        provider: 'example',
        message: 'release detector vendor-stable could not be read',
        retryable: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('sk-secret');
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('cannot report a behind mark without an installed version', async () => {
    const { version: _version, ...withoutVersion } = installed;
    const result = await checkProviderReleases({
      provider: provider({
        detectors: [
          {
            kind: 'text',
            id: 'vendor-stable',
            channel: 'stable',
            url: 'https://downloads.example.com/stable',
            versionPattern: '^(\\d+\\.\\d+\\.\\d+)',
          },
        ],
      }),
      service: service(),
      installed: withoutVersion,
      network: true,
      fetch: (async () => response('9.9.9\n')) as unknown as typeof fetch,
      cache: createReleaseEtagCache(),
    });

    expect(result.releases).toHaveLength(1);
    expect(result.behind).toEqual([]);
  });
});

describe('availableUpdate', () => {
  const releases = [
    { channel: 'stable' as const, version: '1.3.0' },
    { channel: 'stable' as const, version: '1.2.9' },
    { channel: 'preview' as const, version: '1.4.0-rc.1' },
  ];

  it('follows the stable line when the adapter could not tell the install channel', () => {
    expect(availableUpdate(releases, { version: '1.2.3' })).toEqual({ channel: 'stable', version: '1.3.0' });
  });

  it('follows the channel the adapter mapped, not whichever release is newest', () => {
    expect(availableUpdate(releases, { version: '1.2.3', releaseChannel: 'preview' })).toEqual({
      channel: 'preview',
      version: '1.4.0-rc.1',
    });
    // A preview release never offers itself to a stable install.
    expect(availableUpdate([{ channel: 'preview', version: '9.0.0' }], { version: '1.2.3' })).toBeUndefined();
  });

  it('answers nothing when the install is current or its version is unknown', () => {
    expect(availableUpdate(releases, { version: '1.3.0' })).toBeUndefined();
    expect(availableUpdate(releases, {})).toBeUndefined();
    expect(availableUpdate([], { version: '1.2.3' })).toBeUndefined();
  });
});
