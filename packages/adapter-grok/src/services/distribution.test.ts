import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  InstalledAgentSchema,
  InstallRecipeSchema,
  ReleaseSnapshotSchema,
  type InstallCandidate,
} from '@vibefield/puppeteer-core';
import { describe, expect, it } from 'vitest';
import { classifyGrokCandidate, createGrokDistributionService, GROK_DISTRIBUTION_PROVIDER } from './distribution.js';

const candidate = (overrides: Partial<InstallCandidate> & Pick<InstallCandidate, 'realPath'>): InstallCandidate => ({
  executable: overrides.executable ?? '/home/tester/.local/bin/grok',
  origin: overrides.origin ?? 'path',
  ...overrides,
});

const versionOutput = 'grok 1.0.13 (5e9a58528b76) [stable]\n';

describe('Grok distribution provider', () => {
  it('declares the built-in provider identity, commands, and packages', () => {
    expect(GROK_DISTRIBUTION_PROVIDER.id).toBe('grok');
    expect(GROK_DISTRIBUTION_PROVIDER.label).toBe('Grok');
    expect(GROK_DISTRIBUTION_PROVIDER.commands).toEqual(['grok']);
    expect(GROK_DISTRIBUTION_PROVIDER.npmPackages).toEqual(['@xai-official/grok']);
    expect(GROK_DISTRIBUTION_PROVIDER.nativeUpdateCheck).toBe(true);
  });

  it('mirrors the Surface upstream detectors without drifting', () => {
    const upstream = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../surface/vendors/grok/upstream.json', import.meta.url)), 'utf8'),
    ) as { detectors: Record<string, unknown>[] };
    for (const declared of upstream.detectors) {
      const mirrored = GROK_DISTRIBUTION_PROVIDER.detectors.find((entry) => entry.id === declared.id);
      expect(mirrored, `detector ${String(declared.id)} is not mirrored`).toBeDefined();
      expect(mirrored).toMatchObject({
        kind: declared.kind,
        channel: declared.channel,
        url: declared.url,
        versionPattern: declared.versionPattern,
      });
    }
    expect(GROK_DISTRIBUTION_PROVIDER.detectors.some((entry) => entry.kind === 'npm-registry')).toBe(true);
  });
});

describe('Grok install classification', () => {
  it('classifies the vendor downloader and keeps the Grok home as the location', () => {
    expect(
      classifyGrokCandidate(candidate({ realPath: '/home/tester/.grok/downloads/grok-1.0.13-macos-aarch64' })),
    ).toEqual({ method: 'vendor-downloader', location: '/home/tester/.grok' });
  });

  it('classifies an npm global copy from its package root', () => {
    expect(
      classifyGrokCandidate(
        candidate({
          executable: '/opt/node/bin/grok',
          realPath: '/opt/node/lib/node_modules/@xai-official/grok/bin/grok.js',
          origin: 'npm-global',
          packageRoot: '/opt/node/lib/node_modules/@xai-official/grok',
        }),
      ),
    ).toEqual({
      method: 'npm-global',
      packageName: '@xai-official/grok',
      location: '/opt/node/lib/node_modules/@xai-official/grok',
    });
  });

  it('claims a bare grok command without inventing a method', () => {
    expect(classifyGrokCandidate(candidate({ realPath: '/usr/local/bin/grok' }))).toEqual({
      method: 'unknown',
      location: '/usr/local/bin',
    });
  });

  it('does not claim another agent', () => {
    expect(
      classifyGrokCandidate(candidate({ executable: '/usr/local/bin/kimi', realPath: '/usr/local/bin/kimi' })),
    ).toBeUndefined();
  });
});

describe('Grok inspect', () => {
  it('reads the version and channel through the native version command', async () => {
    const service = createGrokDistributionService({ exec: async () => ({ stdout: versionOutput, stderr: '' }) });
    const install = await service.inspect(
      candidate({ realPath: '/home/tester/.grok/downloads/grok-1.0.13-macos-aarch64' }),
    );
    expect(InstalledAgentSchema.parse(install)).toMatchObject({
      provider: 'grok',
      version: '1.0.13',
      channel: 'stable',
      releaseChannel: 'stable',
      method: 'vendor-downloader',
      location: '/home/tester/.grok',
      autoUpdate: 'unknown',
      warnings: [],
    });
  });

  it('records a failed probe as a warning instead of throwing', async () => {
    const service = createGrokDistributionService({
      exec: async () => {
        throw new Error('spawn ENOENT');
      },
    });
    const install = await service.inspect(
      candidate({ realPath: '/home/tester/.grok/downloads/grok-1.0.13-macos-aarch64' }),
    );
    expect(install?.version).toBeUndefined();
    expect(install?.warnings).toHaveLength(1);
    expect(install?.warnings[0]).toContain('spawn ENOENT');
  });
});

describe('Grok update recipes', () => {
  const service = createGrokDistributionService({ exec: async () => ({ stdout: versionOutput, stderr: '' }) });
  const install = (overrides: Partial<Parameters<typeof service.recipeFor>[0]> = {}) => ({
    provider: 'grok',
    executable: '/home/tester/.local/bin/grok',
    realPath: '/home/tester/.grok/downloads/grok-1.0.13-macos-aarch64',
    method: 'vendor-downloader' as const,
    autoUpdate: 'unknown' as const,
    detectedAt: new Date().toISOString(),
    warnings: [],
    ...overrides,
  });

  it('runs the vendor updater for downloader installs', () => {
    expect(service.recipeFor(install())).toEqual({
      kind: 'native-self-update',
      argv: ['/home/tester/.local/bin/grok', 'update'],
    });
  });

  it('hands npm installs back to the package manager', () => {
    expect(service.recipeFor(install({ method: 'npm-global', packageName: '@xai-official/grok' }))).toEqual({
      kind: 'npm-global',
      package: '@xai-official/grok',
    });
  });
});

describe('Grok native update oracle', () => {
  const install = {
    provider: 'grok',
    executable: '/home/tester/.local/bin/grok',
    realPath: '/home/tester/.grok/downloads/grok-1.0.13-macos-aarch64',
    method: 'vendor-downloader' as const,
    autoUpdate: 'unknown' as const,
    detectedAt: new Date().toISOString(),
    warnings: [],
  };

  it('decodes the documented stable payload', async () => {
    const service = createGrokDistributionService({
      exec: async (_file, args) => {
        expect([...args]).toEqual(['update', '--check', '--json']);
        return {
          stdout:
            '{"currentVersion":"1.0.13","latestVersion":"1.0.14","updateAvailable":true,"installer":"internal","channel":"stable","autoUpdate":true,"error":null}',
          stderr: '',
        };
      },
    });
    const snapshot = await service.checkUpdate!(install);
    expect(ReleaseSnapshotSchema.parse(snapshot)).toMatchObject({
      provider: 'grok',
      channel: 'stable',
      version: '1.0.14',
      source: { kind: 'native-oracle', id: 'grok update --check --json' },
    });
  });

  it('maps the alpha channel onto preview', async () => {
    const service = createGrokDistributionService({
      exec: async () => ({ stdout: '{"latestVersion":"1.1.0-alpha.2","channel":"alpha"}', stderr: '' }),
    });
    expect(await service.checkUpdate!(install)).toMatchObject({ channel: 'preview', version: '1.1.0-alpha.2' });
  });

  it('reports a failed oracle as a typed failure', async () => {
    const service = createGrokDistributionService({
      exec: async () => {
        throw new Error('network unreachable');
      },
    });
    expect(await service.checkUpdate!(install)).toMatchObject({
      status: 'unavailable',
      provider: 'grok',
      retryable: true,
    });
  });

  it('reports the oracle error field as a failure', async () => {
    const service = createGrokDistributionService({
      exec: async () => ({ stdout: '{"latestVersion":"1.0.14","error":"rate limited"}', stderr: '' }),
    });
    const result = await service.checkUpdate!(install);
    expect(result).toMatchObject({ status: 'unavailable', retryable: true });
    // The vendor's error text is not forwarded; only the fact of failure is.
    expect(JSON.stringify(result)).not.toContain('rate limited');
  });

  it('reports an unreadable document as a non-retryable failure', async () => {
    const service = createGrokDistributionService({ exec: async () => ({ stdout: 'not json', stderr: '' }) });
    expect(await service.checkUpdate!(install)).toMatchObject({ status: 'unavailable', retryable: true });
  });
});

describe('Grok first install', () => {
  it("runs the vendor's documented installer and looks where it leaves the agent", () => {
    expect(GROK_DISTRIBUTION_PROVIDER.installDirectories).toEqual(['.grok/bin']);
    expect(InstallRecipeSchema.parse(createGrokDistributionService().installRecipe?.())).toEqual({
      kind: 'installer-script',
      url: 'https://x.ai/cli/install.sh',
    });
  });
});
