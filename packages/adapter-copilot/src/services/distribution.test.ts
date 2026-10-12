import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InstalledAgentSchema, type InstallCandidate, type InstalledAgent } from '@vibefield/puppeteer-core';
import { describe, expect, it } from 'vitest';
import {
  classifyCopilotCandidate,
  COPILOT_DISTRIBUTION_PROVIDER,
  createCopilotDistributionService,
} from './distribution.js';

const candidate = (overrides: Partial<InstallCandidate> & Pick<InstallCandidate, 'realPath'>): InstallCandidate => ({
  executable: overrides.executable ?? '/home/tester/.local/bin/copilot',
  origin: overrides.origin ?? 'path',
  ...overrides,
});

// Byte-for-byte native output captured 2026-09-06 on Copilot 1.0.80.
const versionOutput = "GitHub Copilot CLI 1.0.80.\nRun 'copilot update' to check for updates.\n";

const installed = (overrides: Partial<InstalledAgent> = {}): InstalledAgent => ({
  provider: 'copilot',
  executable: '/home/tester/.local/bin/copilot',
  realPath: '/home/tester/.local/bin/copilot',
  method: 'standalone-binary',
  autoUpdate: 'unknown',
  detectedAt: new Date().toISOString(),
  warnings: [],
  ...overrides,
});

describe('Copilot distribution provider', () => {
  it('declares the built-in provider identity, commands, and packages', () => {
    expect(COPILOT_DISTRIBUTION_PROVIDER.id).toBe('copilot');
    expect(COPILOT_DISTRIBUTION_PROVIDER.label).toBe('GitHub Copilot');
    expect(COPILOT_DISTRIBUTION_PROVIDER.commands).toEqual(['copilot']);
    expect(COPILOT_DISTRIBUTION_PROVIDER.npmPackages).toEqual(['@github/copilot']);
    expect(COPILOT_DISTRIBUTION_PROVIDER.nativeUpdateCheck).toBe(false);
  });

  it('mirrors the Surface upstream detectors without drifting', () => {
    const upstream = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../surface/vendors/copilot/upstream.json', import.meta.url)), 'utf8'),
    ) as { detectors: Record<string, unknown>[] };
    for (const declared of upstream.detectors) {
      const mirrored = COPILOT_DISTRIBUTION_PROVIDER.detectors.find((entry) => entry.id === declared.id);
      expect(mirrored, `detector ${String(declared.id)} is not mirrored`).toBeDefined();
      expect(mirrored).toMatchObject({
        kind: declared.kind,
        channel: declared.channel,
        url: declared.url,
        tagPattern: declared.tagPattern,
        prerelease: declared.prerelease,
      });
    }
    expect(COPILOT_DISTRIBUTION_PROVIDER.detectors).toContainEqual({
      kind: 'npm-registry',
      id: 'npm-latest',
      channel: 'stable',
      package: '@github/copilot',
      distTag: 'latest',
    });
  });
});

describe('Copilot install classification', () => {
  it('classifies the vendor-installed standalone binary', () => {
    expect(classifyCopilotCandidate(candidate({ realPath: '/home/tester/.local/bin/copilot' }))).toEqual({
      method: 'standalone-binary',
      location: '/home/tester/.local/bin',
    });
  });

  it('classifies an npm global copy from its package root', () => {
    expect(
      classifyCopilotCandidate(
        candidate({
          executable: '/opt/node/bin/copilot',
          realPath: '/opt/node/lib/node_modules/@github/copilot/index.js',
          origin: 'npm-global',
          packageRoot: '/opt/node/lib/node_modules/@github/copilot',
        }),
      ),
    ).toEqual({
      method: 'npm-global',
      packageName: '@github/copilot',
      location: '/opt/node/lib/node_modules/@github/copilot',
    });
  });

  it('does not claim another agent', () => {
    expect(
      classifyCopilotCandidate(candidate({ executable: '/usr/local/bin/pi', realPath: '/usr/local/bin/pi' })),
    ).toBeUndefined();
  });
});

describe('Copilot inspect', () => {
  it('reads the version from the native sentence-terminated output', async () => {
    const service = createCopilotDistributionService({
      exec: async () => ({ stdout: versionOutput, stderr: '' }),
      env: {},
    });
    const install = await service.inspect(candidate({ realPath: '/home/tester/.local/bin/copilot' }));
    expect(InstalledAgentSchema.parse(install)).toMatchObject({
      provider: 'copilot',
      version: '1.0.80',
      method: 'standalone-binary',
      autoUpdate: 'unknown',
      warnings: [],
    });
  });

  it('reads the documented auto-update kill switch from the environment', async () => {
    const exec = async () => ({ stdout: versionOutput, stderr: '' });
    await expect(
      createCopilotDistributionService({ exec, env: { COPILOT_AUTO_UPDATE: 'false' } }).inspect(
        candidate({ realPath: '/home/tester/.local/bin/copilot' }),
      ),
    ).resolves.toMatchObject({ autoUpdate: 'disabled' });
    await expect(
      createCopilotDistributionService({ exec, env: { COPILOT_AUTO_UPDATE: 'true' } }).inspect(
        candidate({ realPath: '/home/tester/.local/bin/copilot' }),
      ),
    ).resolves.toMatchObject({ autoUpdate: 'enabled' });
  });

  it('records a failed probe as a warning instead of throwing', async () => {
    const service = createCopilotDistributionService({
      exec: async () => {
        throw new Error('spawn ENOENT');
      },
      env: {},
    });
    const install = await service.inspect(candidate({ realPath: '/home/tester/.local/bin/copilot' }));
    expect(install?.version).toBeUndefined();
    expect(install?.warnings[0]).toContain('spawn ENOENT');
  });
});

describe('Copilot update recipes', () => {
  const service = createCopilotDistributionService({
    exec: async () => ({ stdout: versionOutput, stderr: '' }),
    env: {},
  });

  it('runs the vendor updater for standalone installs', () => {
    expect(service.recipeFor(installed())).toEqual({
      kind: 'native-self-update',
      argv: ['/home/tester/.local/bin/copilot', 'update'],
    });
  });

  it('hands npm installs back to the package manager', () => {
    expect(service.recipeFor(installed({ method: 'npm-global', packageName: '@github/copilot' }))).toEqual({
      kind: 'npm-global',
      package: '@github/copilot',
    });
  });
});
