import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InstalledAgentSchema, type InstallCandidate, type InstalledAgent } from '@vibefield/puppeteer-core';
import { describe, expect, it } from 'vitest';
import { classifyPiCandidate, createPiDistributionService, PI_DISTRIBUTION_PROVIDER } from './distribution.js';

const NPM_ROOT = '/home/tester/.nvm/versions/node/v26.5.0/lib/node_modules/@earendil-works/pi-coding-agent';

const candidate = (overrides: Partial<InstallCandidate> & Pick<InstallCandidate, 'realPath'>): InstallCandidate => ({
  executable: overrides.executable ?? '/home/tester/.nvm/versions/node/v26.5.0/bin/pi',
  origin: overrides.origin ?? 'path',
  ...overrides,
});

// Native output captured 2026-09-06 on Pi 0.84.3: a bare semantic version.
const versionOutput = '0.84.3\n';

const installed = (overrides: Partial<InstalledAgent> = {}): InstalledAgent => ({
  provider: 'pi',
  executable: '/home/tester/.nvm/versions/node/v26.5.0/bin/pi',
  realPath: `${NPM_ROOT}/dist/bundle/cli.js`,
  method: 'npm-global',
  packageName: '@earendil-works/pi-coding-agent',
  autoUpdate: 'unknown',
  detectedAt: new Date().toISOString(),
  warnings: [],
  ...overrides,
});

describe('Pi distribution provider', () => {
  it('declares the built-in provider identity, commands, and packages', () => {
    expect(PI_DISTRIBUTION_PROVIDER.id).toBe('pi');
    expect(PI_DISTRIBUTION_PROVIDER.label).toBe('Pi');
    expect(PI_DISTRIBUTION_PROVIDER.commands).toEqual(['pi']);
    expect(PI_DISTRIBUTION_PROVIDER.npmPackages).toEqual(['@earendil-works/pi-coding-agent']);
    expect(PI_DISTRIBUTION_PROVIDER.nativeUpdateCheck).toBe(false);
  });

  it('mirrors the Surface upstream detectors without drifting', () => {
    const upstream = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../surface/vendors/pi/upstream.json', import.meta.url)), 'utf8'),
    ) as { detectors: Record<string, unknown>[] };
    for (const declared of upstream.detectors) {
      const mirrored = PI_DISTRIBUTION_PROVIDER.detectors.find((entry) => entry.id === declared.id);
      expect(mirrored, `detector ${String(declared.id)} is not mirrored`).toBeDefined();
      expect(mirrored).toMatchObject({
        kind: declared.kind,
        channel: declared.channel,
        url: declared.url,
        tagPattern: declared.tagPattern,
        prerelease: declared.prerelease,
      });
    }
    expect(PI_DISTRIBUTION_PROVIDER.detectors).toContainEqual({
      kind: 'npm-registry',
      id: 'npm-latest',
      channel: 'stable',
      package: '@earendil-works/pi-coding-agent',
      distTag: 'latest',
    });
  });
});

describe('Pi install classification', () => {
  it('classifies the npm global bundle from its real path', () => {
    expect(classifyPiCandidate(candidate({ realPath: `${NPM_ROOT}/dist/bundle/cli.js` }))).toEqual({
      method: 'npm-global',
      packageName: '@earendil-works/pi-coding-agent',
      location: NPM_ROOT,
    });
  });

  it('classifies an npm global install from the host-supplied package root', () => {
    expect(
      classifyPiCandidate(candidate({ realPath: '/opt/wrapper/pi-bin', origin: 'npm-global', packageRoot: NPM_ROOT })),
    ).toEqual({ method: 'npm-global', packageName: '@earendil-works/pi-coding-agent', location: NPM_ROOT });
  });

  it('claims a bare pi command without inventing a method', () => {
    expect(classifyPiCandidate(candidate({ executable: '/usr/local/bin/pi', realPath: '/usr/local/bin/pi' }))).toEqual({
      method: 'unknown',
      location: '/usr/local/bin',
    });
  });

  it('does not claim another agent', () => {
    expect(
      classifyPiCandidate(candidate({ executable: '/usr/local/bin/copilot', realPath: '/usr/local/bin/copilot' })),
    ).toBeUndefined();
  });
});

describe('Pi inspect', () => {
  it('reads the version through the native version command', async () => {
    const service = createPiDistributionService({ exec: async () => ({ stdout: versionOutput, stderr: '' }) });
    const install = await service.inspect(candidate({ realPath: `${NPM_ROOT}/dist/bundle/cli.js` }));
    expect(InstalledAgentSchema.parse(install)).toMatchObject({
      provider: 'pi',
      version: '0.84.3',
      method: 'npm-global',
      packageName: '@earendil-works/pi-coding-agent',
      location: NPM_ROOT,
      autoUpdate: 'unknown',
      warnings: [],
    });
  });

  it('records a failed probe as a warning instead of throwing', async () => {
    const service = createPiDistributionService({
      exec: async () => {
        throw new Error('spawn ENOENT');
      },
    });
    const install = await service.inspect(candidate({ realPath: `${NPM_ROOT}/dist/bundle/cli.js` }));
    expect(install?.version).toBeUndefined();
    expect(install?.warnings[0]).toContain('spawn ENOENT');
  });
});

describe('Pi update recipes', () => {
  const service = createPiDistributionService({ exec: async () => ({ stdout: versionOutput, stderr: '' }) });

  it('hands npm installs back to the package manager', () => {
    expect(service.recipeFor(installed())).toEqual({
      kind: 'npm-global',
      package: '@earendil-works/pi-coding-agent',
    });
  });

  it('runs the vendor self-update for any other install', () => {
    expect(service.recipeFor(installed({ method: 'unknown', executable: '/usr/local/bin/pi' }))).toEqual({
      kind: 'native-self-update',
      argv: ['/usr/local/bin/pi', 'update'],
    });
  });
});
