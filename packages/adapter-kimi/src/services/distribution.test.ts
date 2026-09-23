import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InstalledAgentSchema, type InstallCandidate, type InstalledAgent } from '@vibecook/puppeteer-core';
import { describe, expect, it } from 'vitest';
import { classifyKimiCandidate, createKimiDistributionService, KIMI_DISTRIBUTION_PROVIDER } from './distribution.js';

const candidate = (overrides: Partial<InstallCandidate> & Pick<InstallCandidate, 'realPath'>): InstallCandidate => ({
  executable: overrides.executable ?? '/home/tester/.kimi-code/bin/kimi',
  origin: overrides.origin ?? 'path',
  ...overrides,
});

// Native output captured 2026-09-06 on Kimi 0.37.1: a bare semantic version.
const versionOutput = '0.37.1\n';

const installed = (overrides: Partial<InstalledAgent> = {}): InstalledAgent => ({
  provider: 'kimi',
  executable: '/home/tester/.kimi-code/bin/kimi',
  realPath: '/home/tester/.kimi-code/bin/kimi',
  method: 'native-installer',
  location: '/home/tester/.kimi-code',
  autoUpdate: 'unknown',
  detectedAt: new Date().toISOString(),
  warnings: [],
  ...overrides,
});

describe('Kimi distribution provider', () => {
  it('declares the built-in provider identity and no package-manager names', () => {
    expect(KIMI_DISTRIBUTION_PROVIDER.id).toBe('kimi');
    expect(KIMI_DISTRIBUTION_PROVIDER.label).toBe('Kimi');
    expect(KIMI_DISTRIBUTION_PROVIDER.commands).toEqual(['kimi']);
    expect(KIMI_DISTRIBUTION_PROVIDER.npmPackages).toEqual([]);
    expect(KIMI_DISTRIBUTION_PROVIDER.brewNames).toEqual([]);
    expect(KIMI_DISTRIBUTION_PROVIDER.nativeUpdateCheck).toBe(false);
  });

  it('mirrors the Surface upstream detectors without drifting', () => {
    const upstream = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../surface/vendors/kimi/upstream.json', import.meta.url)), 'utf8'),
    ) as { detectors: Record<string, unknown>[] };
    expect(KIMI_DISTRIBUTION_PROVIDER.detectors).toHaveLength(upstream.detectors.length);
    for (const declared of upstream.detectors) {
      const mirrored = KIMI_DISTRIBUTION_PROVIDER.detectors.find((entry) => entry.id === declared.id);
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

describe('Kimi install classification', () => {
  it('classifies the vendor home install as the native installer and keeps that home as the location', () => {
    expect(classifyKimiCandidate(candidate({ realPath: '/home/tester/.kimi-code/bin/kimi' }))).toEqual({
      method: 'native-installer',
      location: '/home/tester/.kimi-code',
    });
  });

  it('claims a kimi command outside the vendor home without inventing a method', () => {
    expect(
      classifyKimiCandidate(candidate({ executable: '/usr/local/bin/kimi', realPath: '/usr/local/bin/kimi' })),
    ).toEqual({ method: 'unknown', location: '/usr/local/bin' });
  });

  it('does not claim another agent', () => {
    expect(
      classifyKimiCandidate(candidate({ executable: '/usr/local/bin/grok', realPath: '/usr/local/bin/grok' })),
    ).toBeUndefined();
  });
});

describe('Kimi inspect', () => {
  it('reads the version through the native version command', async () => {
    const service = createKimiDistributionService({ exec: async () => ({ stdout: versionOutput, stderr: '' }) });
    const install = await service.inspect(candidate({ realPath: '/home/tester/.kimi-code/bin/kimi' }));
    expect(InstalledAgentSchema.parse(install)).toMatchObject({
      provider: 'kimi',
      version: '0.37.1',
      method: 'native-installer',
      location: '/home/tester/.kimi-code',
      autoUpdate: 'unknown',
      warnings: [],
    });
  });

  it('records a failed probe as a warning instead of throwing', async () => {
    const service = createKimiDistributionService({
      exec: async () => {
        throw new Error('spawn ENOENT');
      },
    });
    const install = await service.inspect(candidate({ realPath: '/home/tester/.kimi-code/bin/kimi' }));
    expect(install?.version).toBeUndefined();
    expect(install?.warnings[0]).toContain('spawn ENOENT');
  });
});

describe('Kimi update recipes', () => {
  const service = createKimiDistributionService({
    exec: async () => ({ stdout: versionOutput, stderr: '' }),
    platform: 'darwin',
  });

  // Native evidence 2026-09-22, Kimi 0.37.1: `kimi upgrade` on a native-installer
  // install prints the script to run instead and exits 0, having moved nothing.
  it('updates a native-installer install by running the vendor install script again, in place', () => {
    expect(service.recipeFor(installed())).toEqual({
      kind: 'installer-script',
      url: 'https://code.kimi.com/kimi-code/install.sh',
      env: { KIMI_INSTALL_DIR: '/home/tester/.kimi-code', KIMI_NO_MODIFY_PATH: '1' },
    });
  });

  it('keeps the vendor command when the install method is unknown', () => {
    expect(
      service.recipeFor(
        installed({ method: 'unknown', executable: '/usr/local/bin/kimi', location: '/usr/local/bin' }),
      ),
    ).toEqual({
      kind: 'native-self-update',
      argv: ['/usr/local/bin/kimi', 'upgrade'],
    });
  });

  it('keeps the vendor command on Windows, where the script is not the documented path', () => {
    const windows = createKimiDistributionService({ platform: 'win32' });
    expect(windows.recipeFor(installed())).toEqual({
      kind: 'native-self-update',
      argv: ['/home/tester/.kimi-code/bin/kimi', 'upgrade'],
    });
  });
});
