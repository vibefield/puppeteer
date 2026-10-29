import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DistributionProviderSchema,
  InstalledAgentSchema,
  InstallRecipeSchema,
  type InstallCandidate,
} from '@vibefield/puppeteer-core';
import { CODEX_DISTRIBUTION_PROVIDER, createCodexDistributionService } from './distribution.js';

const BANNER = 'codex-cli 0.153.4\n';

function service(
  overrides: Partial<Parameters<typeof createCodexDistributionService>[0]> = {},
): ReturnType<typeof createCodexDistributionService> {
  return createCodexDistributionService({
    env: {},
    exec: async () => ({ stdout: BANNER }),
    now: () => new Date('2026-09-06T00:00:00.000Z'),
    ...overrides,
  });
}

function candidate(overrides: Partial<InstallCandidate> & Pick<InstallCandidate, 'realPath'>): InstallCandidate {
  return { executable: '/opt/node/bin/codex', origin: 'path', ...overrides };
}

describe('Codex distribution provider', () => {
  it('declares a valid provider with the vendor command and package', () => {
    expect(() => DistributionProviderSchema.parse(CODEX_DISTRIBUTION_PROVIDER)).not.toThrow();
    expect(CODEX_DISTRIBUTION_PROVIDER.id).toBe('codex');
    expect(CODEX_DISTRIBUTION_PROVIDER.commands).toEqual(['codex']);
    expect(CODEX_DISTRIBUTION_PROVIDER.npmPackages).toEqual(['@openai/codex']);
    expect(CODEX_DISTRIBUTION_PROVIDER.brewNames).toEqual(['codex']);
    // `codex update` updates; it never reports what is available.
    expect(CODEX_DISTRIBUTION_PROVIDER.nativeUpdateCheck).toBe(false);
  });

  it('mirrors the Surface-declared release detectors without drift', () => {
    const require = createRequire(import.meta.url);
    const surfaceRoot = dirname(require.resolve('@vibefield/puppeteer-surface/package.json'));
    const upstream = JSON.parse(readFileSync(join(surfaceRoot, 'vendors', 'codex', 'upstream.json'), 'utf8')) as {
      detectors: Array<Record<string, unknown>>;
    };

    for (const declared of upstream.detectors) {
      const mirrored = CODEX_DISTRIBUTION_PROVIDER.detectors.find((entry) => entry.id === declared.id);
      expect(mirrored, `detector ${String(declared.id)} is not mirrored in the adapter`).toBeDefined();
      expect(mirrored?.kind).toBe(declared.kind);
      expect(mirrored?.channel).toBe(declared.channel);
      expect(mirrored && 'url' in mirrored ? mirrored.url : undefined).toBe(declared.url);
      if (mirrored?.kind === 'github-release') {
        expect(mirrored.tagPattern).toBe(declared.tagPattern);
        expect(mirrored.prerelease).toBe(declared.prerelease);
      }
    }
  });

  it('adds the npm dist-tag detector the vendor also publishes to', () => {
    expect(CODEX_DISTRIBUTION_PROVIDER.detectors).toContainEqual({
      kind: 'npm-registry',
      id: 'npm-latest',
      channel: 'stable',
      package: '@openai/codex',
      distTag: 'latest',
    });
  });
});

describe('Codex install classification', () => {
  it('classifies a global npm install from the JavaScript shim', async () => {
    const install = await service().inspect(
      candidate({ realPath: '/opt/node/lib/node_modules/@openai/codex/bin/codex.js' }),
    );
    expect(install).toBeDefined();
    expect(() => InstalledAgentSchema.parse(install)).not.toThrow();
    expect(install?.method).toBe('npm-global');
    expect(install?.packageName).toBe('@openai/codex');
    expect(install?.location).toBe('/opt/node/lib/node_modules/@openai/codex');
    expect(install?.version).toBe('0.153.4');
  });

  it('classifies a global npm install from the package root', async () => {
    const install = await service().inspect(
      candidate({
        realPath: '/opt/node/bin/codex',
        origin: 'npm-global',
        packageRoot: '/opt/node/lib/node_modules/@openai/codex',
      }),
    );
    expect(install?.method).toBe('npm-global');
    expect(install?.location).toBe('/opt/node/lib/node_modules/@openai/codex');
  });

  it('classifies a Homebrew install', async () => {
    const install = await service().inspect(
      candidate({
        executable: '/opt/homebrew/bin/codex',
        realPath: '/opt/homebrew/Caskroom/codex/0.153.4/codex',
        origin: 'brew',
      }),
    );
    expect(install?.method).toBe('brew');
    expect(install?.packageName).toBe('codex');
    expect(install?.location).toBe('/opt/homebrew/Caskroom/codex');
  });

  it('classifies an unrecognized layout as a standalone binary', async () => {
    const install = await service().inspect(
      candidate({ executable: '/usr/local/bin/codex', realPath: '/usr/local/bin/codex' }),
    );
    expect(install?.method).toBe('standalone-binary');
    expect(install?.location).toBeUndefined();
  });

  it('reports auto-update as unknown because Codex publishes no switch', async () => {
    const install = await service().inspect(
      candidate({ realPath: '/opt/node/lib/node_modules/@openai/codex/bin/codex.js' }),
    );
    expect(install?.autoUpdate).toBe('unknown');
  });

  it('rejects a PATH candidate whose version banner names another agent', async () => {
    const install = await service({ exec: async () => ({ stdout: '1.18.23\n' }) }).inspect(
      candidate({ executable: '/usr/local/bin/codex', realPath: '/usr/local/bin/codex' }),
    );
    expect(install).toBeUndefined();
  });

  it('keeps the configured executable even when its banner is not the vendor one', async () => {
    const install = await service({
      executable: '/tmp/ai.mjs',
      exec: async () => ({ stdout: 'imposter 9.9.9\n' }),
    }).inspect(candidate({ executable: '/tmp/ai.mjs', realPath: '/tmp/ai.mjs', origin: 'configured' }));
    expect(install?.method).toBe('standalone-binary');
    expect(install?.version).toBeUndefined();
    expect(install?.warnings.some((warning) => warning.includes('could not parse a version'))).toBe(true);
  });

  it('warns instead of throwing when the version probe fails', async () => {
    const install = await service({
      exec: async () => {
        throw new Error('spawn ENOENT');
      },
    }).inspect(candidate({ realPath: '/opt/node/lib/node_modules/@openai/codex/bin/codex.js' }));
    expect(install?.version).toBeUndefined();
    expect(install?.warnings.some((warning) => warning.includes('spawn ENOENT'))).toBe(true);
  });
});

describe('Codex update recipe', () => {
  it('always runs the vendor updater, which resolves the package manager itself', () => {
    const distribution = service();
    const install = {
      provider: 'codex' as const,
      executable: '/opt/node/bin/codex',
      realPath: '/opt/node/lib/node_modules/@openai/codex/bin/codex.js',
      method: 'npm-global' as const,
      packageName: '@openai/codex',
      autoUpdate: 'unknown' as const,
      detectedAt: '2026-09-06T00:00:00.000Z',
      warnings: [],
    };
    const expected = { kind: 'native-self-update', argv: ['/opt/node/bin/codex', 'update'] };
    expect(distribution.recipeFor(install)).toEqual(expected);
    expect(distribution.recipeFor({ ...install, method: 'brew', packageName: 'codex' })).toEqual(expected);
    expect(distribution.recipeFor({ ...install, method: 'standalone-binary' })).toEqual(expected);
  });
});

describe('Codex first install', () => {
  it("runs the vendor's documented installer and looks where it leaves the agent", () => {
    expect(CODEX_DISTRIBUTION_PROVIDER.installDirectories).toEqual(['.local/bin']);
    expect(InstallRecipeSchema.parse(createCodexDistributionService().installRecipe?.())).toEqual({
      kind: 'installer-script',
      url: 'https://chatgpt.com/codex/install.sh',
      shell: 'sh',
      env: { CODEX_NON_INTERACTIVE: '1' },
    });
  });
});
