import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InstalledAgentSchema, type InstallCandidate, type InstalledAgent } from '@vibecook/puppeteer-core';
import { describe, expect, it } from 'vitest';
import {
  createHermesDistributionService,
  HERMES_DISTRIBUTION_PROVIDER,
  hermesCheckoutFromWrapper,
} from './distribution.js';

const candidate = (overrides: Partial<InstallCandidate> & Pick<InstallCandidate, 'realPath'>): InstallCandidate => ({
  executable: overrides.executable ?? '/home/tester/.local/bin/hermes',
  origin: overrides.origin ?? 'path',
  ...overrides,
});

// Wrapper script captured 2026-09-06 from a Hermes 0.20.5 install.
const wrapper = [
  '#!/usr/bin/env bash',
  'unset PYTHONPATH',
  'unset PYTHONHOME',
  'exec "/home/tester/.hermes/hermes-agent/venv/bin/python" "/home/tester/.hermes/hermes-agent/hermes" "$@"',
  '',
].join('\n');

// Grammar the digest-locked Surface projection declares for `hermes --version`.
const versionOutput = 'Hermes Agent v0.20.5 (2026.8.19)\n';

const installed = (overrides: Partial<InstalledAgent> = {}): InstalledAgent => ({
  provider: 'hermes',
  executable: '/home/tester/.local/bin/hermes',
  realPath: '/home/tester/.local/bin/hermes',
  method: 'source-checkout',
  location: '/home/tester/.hermes/hermes-agent',
  autoUpdate: 'unknown',
  detectedAt: new Date().toISOString(),
  warnings: [],
  ...overrides,
});

describe('Hermes distribution provider', () => {
  it('declares the built-in provider identity and no package-manager names', () => {
    expect(HERMES_DISTRIBUTION_PROVIDER.id).toBe('hermes');
    expect(HERMES_DISTRIBUTION_PROVIDER.label).toBe('Hermes');
    expect(HERMES_DISTRIBUTION_PROVIDER.commands).toEqual(['hermes']);
    expect(HERMES_DISTRIBUTION_PROVIDER.npmPackages).toEqual([]);
    // `hermes update --check` prints prose, which is never a semantic source.
    expect(HERMES_DISTRIBUTION_PROVIDER.nativeUpdateCheck).toBe(false);
  });

  it('mirrors the Surface upstream detectors without drifting', () => {
    const upstream = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../surface/vendors/hermes/upstream.json', import.meta.url)), 'utf8'),
    ) as { detectors: Record<string, unknown>[] };
    expect(HERMES_DISTRIBUTION_PROVIDER.detectors).toHaveLength(upstream.detectors.length);
    for (const declared of upstream.detectors) {
      const mirrored = HERMES_DISTRIBUTION_PROVIDER.detectors.find((entry) => entry.id === declared.id);
      expect(mirrored, `detector ${String(declared.id)} is not mirrored`).toBeDefined();
      expect(mirrored).toMatchObject({
        kind: declared.kind,
        channel: declared.channel,
        url: declared.url,
        tagPattern: declared.tagPattern,
        titlePattern: declared.titlePattern,
        prerelease: declared.prerelease,
      });
    }
  });
});

describe('Hermes wrapper fingerprint', () => {
  it('reads the checkout out of the installer wrapper', () => {
    expect(hermesCheckoutFromWrapper(wrapper)).toBe('/home/tester/.hermes/hermes-agent');
  });

  it('rejects anything that is not a script', () => {
    expect(hermesCheckoutFromWrapper('ELF')).toBeUndefined();
    expect(hermesCheckoutFromWrapper('#!/bin/sh\nexec /usr/bin/other "$@"\n')).toBeUndefined();
  });
});

describe('Hermes inspect', () => {
  it('classifies the source checkout from the wrapper and reads the version', async () => {
    const service = createHermesDistributionService({
      exec: async () => ({ stdout: versionOutput, stderr: '' }),
      readHead: async () => wrapper,
    });
    const install = await service.inspect(candidate({ realPath: '/home/tester/.local/bin/hermes' }));
    expect(InstalledAgentSchema.parse(install)).toMatchObject({
      provider: 'hermes',
      version: '0.20.5',
      method: 'source-checkout',
      location: '/home/tester/.hermes/hermes-agent',
      autoUpdate: 'unknown',
      warnings: [],
    });
  });

  it('does not claim another agent', async () => {
    const service = createHermesDistributionService({
      exec: async () => ({ stdout: versionOutput, stderr: '' }),
      readHead: async () => wrapper,
    });
    await expect(
      service.inspect(candidate({ executable: '/usr/local/bin/kimi', realPath: '/usr/local/bin/kimi' })),
    ).resolves.toBeUndefined();
  });

  it('keeps the install without a method when the wrapper cannot be read', async () => {
    const service = createHermesDistributionService({
      exec: async () => ({ stdout: versionOutput, stderr: '' }),
      readHead: async () => {
        throw new Error('EACCES');
      },
    });
    const install = await service.inspect(candidate({ realPath: '/home/tester/.local/bin/hermes' }));
    expect(install).toMatchObject({ method: 'unknown', location: '/home/tester/.local/bin', version: '0.20.5' });
    expect(install?.warnings[0]).toContain('EACCES');
  });

  it('warns instead of throwing when the version grammar does not match', async () => {
    const service = createHermesDistributionService({
      exec: async () => ({ stdout: 'hermes (development build)\n', stderr: '' }),
      readHead: async () => wrapper,
    });
    const install = await service.inspect(candidate({ realPath: '/home/tester/.local/bin/hermes' }));
    expect(install?.version).toBeUndefined();
    expect(install?.warnings[0]).toContain('unrecognized version string');
  });
});

describe('Hermes update recipes', () => {
  const service = createHermesDistributionService({
    exec: async () => ({ stdout: versionOutput, stderr: '' }),
    readHead: async () => wrapper,
  });

  it('runs the non-interactive vendor updater', () => {
    expect(service.recipeFor(installed())).toEqual({
      kind: 'native-self-update',
      argv: ['/home/tester/.local/bin/hermes', 'update', '--yes'],
      timeoutMs: 45 * 60_000,
    });
  });
});
