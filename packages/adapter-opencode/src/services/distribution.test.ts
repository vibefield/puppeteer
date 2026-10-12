import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InstalledAgentSchema, type InstallCandidate, type InstalledAgent } from '@vibefield/puppeteer-core';
import { describe, expect, it } from 'vitest';
import {
  autoUpdateFromConfig,
  classifyOpenCodeCandidate,
  createOpenCodeDistributionService,
  OPENCODE_DISTRIBUTION_PROVIDER,
} from './distribution.js';

const candidate = (overrides: Partial<InstallCandidate> & Pick<InstallCandidate, 'realPath'>): InstallCandidate => ({
  executable: overrides.executable ?? '/home/tester/.opencode/bin/opencode',
  origin: overrides.origin ?? 'path',
  ...overrides,
});

// Native output captured 2026-09-06 on OpenCode 1.18.23: a bare version.
const versionOutput = '1.18.23\n';

const missingConfig = async (): Promise<string> => {
  throw new Error('ENOENT');
};

const service = (
  overrides: Partial<Parameters<typeof createOpenCodeDistributionService>[0]> = {},
): ReturnType<typeof createOpenCodeDistributionService> =>
  createOpenCodeDistributionService({
    exec: async () => ({ stdout: versionOutput, stderr: '' }),
    readConfigFile: missingConfig,
    env: {},
    home: '/home/tester',
    ...overrides,
  });

const installed = (overrides: Partial<InstalledAgent> = {}): InstalledAgent => ({
  provider: 'opencode',
  executable: '/home/tester/.opencode/bin/opencode',
  realPath: '/home/tester/.opencode/bin/opencode',
  method: 'standalone-binary',
  autoUpdate: 'unknown',
  detectedAt: new Date().toISOString(),
  warnings: [],
  ...overrides,
});

describe('OpenCode distribution provider', () => {
  it('declares the built-in provider identity, commands, and package names', () => {
    expect(OPENCODE_DISTRIBUTION_PROVIDER.id).toBe('opencode');
    expect(OPENCODE_DISTRIBUTION_PROVIDER.label).toBe('OpenCode');
    expect(OPENCODE_DISTRIBUTION_PROVIDER.commands).toEqual(['opencode']);
    expect(OPENCODE_DISTRIBUTION_PROVIDER.npmPackages).toEqual(['opencode-ai']);
    expect(OPENCODE_DISTRIBUTION_PROVIDER.brewNames).toEqual(['opencode']);
    expect(OPENCODE_DISTRIBUTION_PROVIDER.nativeUpdateCheck).toBe(false);
  });

  it('mirrors the Surface upstream detectors without drifting', () => {
    const upstream = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../surface/vendors/opencode/upstream.json', import.meta.url)), 'utf8'),
    ) as { detectors: Record<string, unknown>[] };
    for (const declared of upstream.detectors) {
      const mirrored = OPENCODE_DISTRIBUTION_PROVIDER.detectors.find((entry) => entry.id === declared.id);
      expect(mirrored, `detector ${String(declared.id)} is not mirrored`).toBeDefined();
      expect(mirrored).toMatchObject({
        kind: declared.kind,
        channel: declared.channel,
        url: declared.url,
        tagPattern: declared.tagPattern,
        prerelease: declared.prerelease,
      });
    }
    expect(OPENCODE_DISTRIBUTION_PROVIDER.detectors).toContainEqual({
      kind: 'npm-registry',
      id: 'npm-latest',
      channel: 'stable',
      package: 'opencode-ai',
      distTag: 'latest',
    });
  });
});

describe('OpenCode install classification', () => {
  it('classifies the vendor home install', () => {
    expect(classifyOpenCodeCandidate(candidate({ realPath: '/home/tester/.opencode/bin/opencode' }))).toEqual({
      method: 'standalone-binary',
      location: '/home/tester/.opencode',
    });
  });

  it('classifies an npm global copy', () => {
    expect(
      classifyOpenCodeCandidate(
        candidate({
          executable: '/opt/node/bin/opencode',
          realPath: '/opt/node/lib/node_modules/opencode-ai/bin/opencode',
          origin: 'npm-global',
          packageRoot: '/opt/node/lib/node_modules/opencode-ai',
        }),
      ),
    ).toEqual({
      method: 'npm-global',
      packageName: 'opencode-ai',
      location: '/opt/node/lib/node_modules/opencode-ai',
    });
  });

  it('classifies a Homebrew cellar install', () => {
    expect(
      classifyOpenCodeCandidate(
        candidate({
          executable: '/opt/homebrew/bin/opencode',
          realPath: '/opt/homebrew/Cellar/opencode/1.18.23/bin/opencode',
          origin: 'brew',
        }),
      ),
    ).toEqual({ method: 'brew', packageName: 'opencode', location: '/opt/homebrew/Cellar/opencode/1.18.23' });
  });

  it('does not claim another agent', () => {
    expect(
      classifyOpenCodeCandidate(candidate({ executable: '/usr/local/bin/kimi', realPath: '/usr/local/bin/kimi' })),
    ).toBeUndefined();
  });
});

describe('OpenCode auto-update evidence', () => {
  it('reads the three documented config values and nothing else', () => {
    expect(autoUpdateFromConfig('{"autoupdate":true}')).toBe('enabled');
    expect(autoUpdateFromConfig('{"autoupdate":false}')).toBe('disabled');
    // "notify" reports a new release but never replaces the binary.
    expect(autoUpdateFromConfig('{"autoupdate":"notify"}')).toBe('disabled');
    expect(autoUpdateFromConfig('{"mcp":{}}')).toBeUndefined();
    expect(autoUpdateFromConfig('not json')).toBeUndefined();
  });

  it('reads the config beside the XDG config root', async () => {
    const seen: string[] = [];
    const install = await service({
      readConfigFile: async (path) => {
        seen.push(path);
        return '{"autoupdate":false}';
      },
      env: { XDG_CONFIG_HOME: '/home/tester/.xdg-config' },
    }).inspect(candidate({ realPath: '/home/tester/.opencode/bin/opencode' }));
    expect(seen).toEqual([join('/home/tester/.xdg-config', 'opencode', 'opencode.json')]);
    expect(install?.autoUpdate).toBe('disabled');
  });

  it('falls back to the default config location', async () => {
    const seen: string[] = [];
    await service({
      readConfigFile: async (path) => {
        seen.push(path);
        return '{"autoupdate":true}';
      },
    }).inspect(candidate({ realPath: '/home/tester/.opencode/bin/opencode' }));
    expect(seen).toEqual([join('/home/tester', '.config', 'opencode', 'opencode.json')]);
  });
});

describe('OpenCode inspect', () => {
  it('reads the version through the native version command', async () => {
    const install = await service().inspect(candidate({ realPath: '/home/tester/.opencode/bin/opencode' }));
    expect(InstalledAgentSchema.parse(install)).toMatchObject({
      provider: 'opencode',
      version: '1.18.23',
      method: 'standalone-binary',
      location: '/home/tester/.opencode',
      autoUpdate: 'unknown',
      warnings: [],
    });
  });

  it('records a failed probe as a warning instead of throwing', async () => {
    const install = await service({
      exec: async () => {
        throw new Error('spawn ENOENT');
      },
    }).inspect(candidate({ realPath: '/home/tester/.opencode/bin/opencode' }));
    expect(install?.version).toBeUndefined();
    expect(install?.warnings[0]).toContain('spawn ENOENT');
  });
});

describe('OpenCode update recipes', () => {
  it('runs the vendor upgrade command for standalone and brew installs', () => {
    expect(service().recipeFor(installed())).toEqual({
      kind: 'native-self-update',
      argv: ['/home/tester/.opencode/bin/opencode', 'upgrade'],
    });
    expect(
      service().recipeFor(
        installed({ method: 'brew', packageName: 'opencode', executable: '/opt/homebrew/bin/opencode' }),
      ),
    ).toEqual({ kind: 'native-self-update', argv: ['/opt/homebrew/bin/opencode', 'upgrade'] });
  });

  it('hands npm installs back to the package manager', () => {
    expect(service().recipeFor(installed({ method: 'npm-global', packageName: 'opencode-ai' }))).toEqual({
      kind: 'npm-global',
      package: 'opencode-ai',
    });
  });
});
