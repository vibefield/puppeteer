import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InstalledAgentSchema, type InstallCandidate, type InstalledAgent } from '@vibefield/puppeteer-core';
import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_DISTRIBUTION_PROVIDER,
  classifyAntigravityCandidate,
  createAntigravityDistributionService,
} from './distribution.js';

const candidate = (overrides: Partial<InstallCandidate> & Pick<InstallCandidate, 'realPath'>): InstallCandidate => ({
  executable: overrides.executable ?? '/home/tester/.local/bin/agy',
  origin: overrides.origin ?? 'path',
  ...overrides,
});

// Native output captured 2026-09-06 on Antigravity 1.1.21: a bare version.
const versionOutput = '1.1.21\n';

const installed = (overrides: Partial<InstalledAgent> = {}): InstalledAgent => ({
  provider: 'antigravity',
  executable: '/home/tester/.local/bin/agy',
  realPath: '/home/tester/.local/bin/agy',
  method: 'standalone-binary',
  autoUpdate: 'unknown',
  detectedAt: new Date().toISOString(),
  warnings: [],
  ...overrides,
});

describe('Antigravity distribution provider', () => {
  it('declares both native command names and no package-manager names', () => {
    expect(ANTIGRAVITY_DISTRIBUTION_PROVIDER.id).toBe('antigravity');
    expect(ANTIGRAVITY_DISTRIBUTION_PROVIDER.label).toBe('Antigravity');
    expect(ANTIGRAVITY_DISTRIBUTION_PROVIDER.commands).toEqual(['agy', 'antigravity']);
    expect(ANTIGRAVITY_DISTRIBUTION_PROVIDER.npmPackages).toEqual([]);
    expect(ANTIGRAVITY_DISTRIBUTION_PROVIDER.brewNames).toEqual([]);
    expect(ANTIGRAVITY_DISTRIBUTION_PROVIDER.nativeUpdateCheck).toBe(false);
  });

  it('mirrors the Surface upstream detectors without drifting', () => {
    const upstream = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../surface/vendors/antigravity/upstream.json', import.meta.url)),
        'utf8',
      ),
    ) as { detectors: Record<string, unknown>[] };
    expect(ANTIGRAVITY_DISTRIBUTION_PROVIDER.detectors).toHaveLength(upstream.detectors.length);
    for (const declared of upstream.detectors) {
      const mirrored = ANTIGRAVITY_DISTRIBUTION_PROVIDER.detectors.find((entry) => entry.id === declared.id);
      expect(mirrored, `detector ${String(declared.id)} is not mirrored`).toBeDefined();
      expect(mirrored).toMatchObject({
        kind: declared.kind,
        channel: declared.channel,
        url: declared.url,
        tagPattern: declared.tagPattern,
        prerelease: declared.prerelease,
      });
    }
  });
});

describe('Antigravity install classification', () => {
  it('classifies the unpacked vendor binary under either command name', () => {
    expect(classifyAntigravityCandidate(candidate({ realPath: '/home/tester/.local/bin/agy' }))).toEqual({
      method: 'standalone-binary',
      location: '/home/tester/.local/bin',
    });
    expect(
      classifyAntigravityCandidate(candidate({ executable: '/opt/bin/antigravity', realPath: '/opt/bin/antigravity' })),
    ).toEqual({ method: 'standalone-binary', location: '/opt/bin' });
  });

  it('does not claim another agent', () => {
    expect(
      classifyAntigravityCandidate(candidate({ executable: '/usr/local/bin/grok', realPath: '/usr/local/bin/grok' })),
    ).toBeUndefined();
  });
});

describe('Antigravity inspect', () => {
  it('reads the version through the native version command', async () => {
    const service = createAntigravityDistributionService({
      exec: async () => ({ stdout: versionOutput, stderr: '' }),
      env: {},
    });
    const install = await service.inspect(candidate({ realPath: '/home/tester/.local/bin/agy' }));
    expect(InstalledAgentSchema.parse(install)).toMatchObject({
      provider: 'antigravity',
      version: '1.1.21',
      method: 'standalone-binary',
      location: '/home/tester/.local/bin',
      autoUpdate: 'unknown',
      warnings: [],
    });
  });

  it('reads the documented auto-update kill switch from the environment', async () => {
    const exec = async () => ({ stdout: versionOutput, stderr: '' });
    await expect(
      createAntigravityDistributionService({ exec, env: { AGY_CLI_DISABLE_AUTO_UPDATE: '1' } }).inspect(
        candidate({ realPath: '/home/tester/.local/bin/agy' }),
      ),
    ).resolves.toMatchObject({ autoUpdate: 'disabled' });
    await expect(
      createAntigravityDistributionService({ exec, env: { AGY_CLI_DISABLE_AUTO_UPDATE: '0' } }).inspect(
        candidate({ realPath: '/home/tester/.local/bin/agy' }),
      ),
    ).resolves.toMatchObject({ autoUpdate: 'enabled' });
  });

  it('records a failed probe as a warning instead of throwing', async () => {
    const service = createAntigravityDistributionService({
      exec: async () => {
        throw new Error('spawn ENOENT');
      },
      env: {},
    });
    const install = await service.inspect(candidate({ realPath: '/home/tester/.local/bin/agy' }));
    expect(install?.version).toBeUndefined();
    expect(install?.warnings[0]).toContain('spawn ENOENT');
  });
});

describe('Antigravity update recipes', () => {
  const service = createAntigravityDistributionService({
    exec: async () => ({ stdout: versionOutput, stderr: '' }),
    env: {},
  });

  it('runs the vendor update subcommand', () => {
    expect(service.recipeFor(installed())).toEqual({
      kind: 'native-self-update',
      argv: ['/home/tester/.local/bin/agy', 'update'],
    });
  });
});
