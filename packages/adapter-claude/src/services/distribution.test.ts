import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DistributionProviderSchema, InstalledAgentSchema, type InstallCandidate } from '@vibecook/puppeteer-core';
import {
  CLAUDE_DISTRIBUTION_PROVIDER,
  claudeReleaseChannel,
  createClaudeDistributionService,
  evaluateClaudeAutoUpdate,
} from './distribution.js';

const HOME = '/Users/test';
const BANNER = '2.1.263 (Claude Code)\n';

function fakeFiles(entries: Record<string, unknown>): (path: string) => Promise<string> {
  return async (path) => {
    if (!(path in entries)) throw new Error(`ENOENT: ${path}`);
    return JSON.stringify(entries[path]);
  };
}

const nativeConfig = {
  [join(HOME, '.claude.json')]: { installMethod: 'native', autoUpdates: false, autoUpdatesProtectedForNative: true },
};

function service(
  overrides: Partial<Parameters<typeof createClaudeDistributionService>[0]> = {},
): ReturnType<typeof createClaudeDistributionService> {
  return createClaudeDistributionService({
    home: HOME,
    env: {},
    readFile: fakeFiles(nativeConfig),
    exec: async () => ({ stdout: BANNER }),
    now: () => new Date('2026-09-06T00:00:00.000Z'),
    ...overrides,
  });
}

function candidate(overrides: Partial<InstallCandidate> & Pick<InstallCandidate, 'realPath'>): InstallCandidate {
  return { executable: '/Users/test/.local/bin/claude', origin: 'path', ...overrides };
}

describe('Claude distribution provider', () => {
  it('declares a valid provider with the vendor commands and packages', () => {
    expect(() => DistributionProviderSchema.parse(CLAUDE_DISTRIBUTION_PROVIDER)).not.toThrow();
    expect(CLAUDE_DISTRIBUTION_PROVIDER.id).toBe('claude');
    expect(CLAUDE_DISTRIBUTION_PROVIDER.commands).toEqual(['claude']);
    expect(CLAUDE_DISTRIBUTION_PROVIDER.npmPackages).toEqual(['@anthropic-ai/claude-code']);
    expect(CLAUDE_DISTRIBUTION_PROVIDER.brewNames).toEqual(['claude-code', 'claude-code@latest']);
    // `claude doctor` reports the last update, never the newest release.
    expect(CLAUDE_DISTRIBUTION_PROVIDER.nativeUpdateCheck).toBe(false);
  });

  it('mirrors the Surface-declared release detectors without drift', () => {
    const require = createRequire(import.meta.url);
    const surfaceRoot = dirname(require.resolve('@vibecook/puppeteer-surface/package.json'));
    const upstream = JSON.parse(readFileSync(join(surfaceRoot, 'vendors', 'claude', 'upstream.json'), 'utf8')) as {
      detectors: Array<Record<string, unknown>>;
    };

    for (const declared of upstream.detectors) {
      const mirrored = CLAUDE_DISTRIBUTION_PROVIDER.detectors.find((entry) => entry.id === declared.id);
      expect(mirrored, `detector ${String(declared.id)} is not mirrored in the adapter`).toBeDefined();
      expect(mirrored?.kind).toBe(declared.kind);
      expect(mirrored?.channel).toBe(declared.channel);
      expect(mirrored && 'url' in mirrored ? mirrored.url : undefined).toBe(declared.url);
      if (mirrored?.kind === 'text') expect(mirrored.versionPattern).toBe(declared.versionPattern);
      if (mirrored?.kind === 'github-release') {
        expect(mirrored.tagPattern).toBe(declared.tagPattern);
        expect(mirrored.prerelease).toBe(declared.prerelease);
      }
    }
    // Claude publishes no npm dist-tag detector, so the sets match exactly.
    expect(CLAUDE_DISTRIBUTION_PROVIDER.detectors.map((entry) => entry.id).sort()).toEqual(
      upstream.detectors.map((entry) => entry.id).sort(),
    );
  });
});

describe('Claude install classification', () => {
  it('classifies the native installer from the versions layout', async () => {
    const install = await service().inspect(
      candidate({ realPath: join(HOME, '.local/share/claude/versions/2.1.263') }),
    );
    expect(install).toBeDefined();
    expect(() => InstalledAgentSchema.parse(install)).not.toThrow();
    expect(install?.method).toBe('native-installer');
    expect(install?.location).toBe(join(HOME, '.local/share/claude/versions'));
    expect(install?.version).toBe('2.1.263');
    expect(install?.packageName).toBeUndefined();
  });

  it('classifies a global npm install from the package root', async () => {
    const fromRealPath = await service().inspect(
      candidate({
        executable: '/opt/node/bin/claude',
        realPath: '/opt/node/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      }),
    );
    expect(fromRealPath?.method).toBe('npm-global');
    expect(fromRealPath?.packageName).toBe('@anthropic-ai/claude-code');
    expect(fromRealPath?.location).toBe('/opt/node/lib/node_modules/@anthropic-ai/claude-code');

    const fromPackageRoot = await service().inspect(
      candidate({
        executable: '/opt/node/bin/claude',
        realPath: '/opt/node/bin/claude',
        origin: 'npm-global',
        packageRoot: '/opt/node/lib/node_modules/@anthropic-ai/claude-code',
      }),
    );
    expect(fromPackageRoot?.method).toBe('npm-global');
    expect(fromPackageRoot?.location).toBe('/opt/node/lib/node_modules/@anthropic-ai/claude-code');
  });

  it('classifies a Homebrew cask install', async () => {
    const install = await service().inspect(
      candidate({
        executable: '/opt/homebrew/bin/claude',
        realPath: '/opt/homebrew/Caskroom/claude-code/2.1.263/claude',
        origin: 'brew',
      }),
    );
    expect(install?.method).toBe('brew');
    expect(install?.packageName).toBe('claude-code');
    expect(install?.location).toBe('/opt/homebrew/Caskroom/claude-code');
  });

  it('classifies an unrecognized layout as a standalone binary', async () => {
    const install = await service().inspect(
      candidate({ executable: '/usr/local/bin/claude', realPath: '/usr/local/bin/claude' }),
    );
    expect(install?.method).toBe('standalone-binary');
    expect(install?.location).toBeUndefined();
  });

  it('rejects a PATH candidate whose version banner names another agent', async () => {
    const install = await service({ exec: async () => ({ stdout: 'grok 1.0.13 (5e9a5852) [stable]\n' }) }).inspect(
      candidate({ executable: '/usr/local/bin/claude', realPath: '/usr/local/bin/claude' }),
    );
    expect(install).toBeUndefined();
  });

  it('keeps a configured executable whose banner is not the vendor one', async () => {
    const install = await service({ exec: async () => ({ stdout: '9.9.9 (imposter)\n' }) }).inspect(
      candidate({ executable: '/tmp/ai.mjs', realPath: '/tmp/ai.mjs', origin: 'configured' }),
    );
    expect(install?.method).toBe('standalone-binary');
    expect(install?.version).toBe('9.9.9');
  });

  it('warns instead of throwing when the version probe fails', async () => {
    const install = await service({
      exec: async () => {
        throw new Error('spawn ENOENT');
      },
    }).inspect(candidate({ realPath: join(HOME, '.local/share/claude/versions/2.1.263') }));
    expect(install?.version).toBeUndefined();
    expect(install?.warnings.some((warning) => warning.includes('spawn ENOENT'))).toBe(true);
  });
});

describe('Claude auto-update evidence', () => {
  it('reports enabled for a native install that carries the ignored legacy key', () => {
    const evidence = evaluateClaudeAutoUpdate(
      'native-installer',
      { installMethod: 'native', autoUpdates: false, autoUpdatesProtectedForNative: true },
      undefined,
      {},
    );
    expect(evidence.autoUpdate).toBe('enabled');
    expect(evidence.warnings).toHaveLength(1);
  });

  it('honours an explicit opt-out on a non-native install', () => {
    expect(evaluateClaudeAutoUpdate('npm-global', { autoUpdates: false }, undefined, {}).autoUpdate).toBe('disabled');
    expect(evaluateClaudeAutoUpdate('npm-global', { autoUpdates: true }, undefined, {}).autoUpdate).toBe('enabled');
  });

  it('treats the vendor kill switches as disabling', () => {
    expect(
      evaluateClaudeAutoUpdate('native-installer', { autoUpdates: true }, undefined, { DISABLE_UPDATES: '1' }),
    ).toMatchObject({ autoUpdate: 'disabled' });
    expect(
      evaluateClaudeAutoUpdate('native-installer', { autoUpdates: true }, undefined, { DISABLE_AUTOUPDATER: 'true' }),
    ).toMatchObject({ autoUpdate: 'disabled' });
    // An empty or falsy value is not a switch.
    expect(
      evaluateClaudeAutoUpdate('native-installer', { autoUpdates: true }, undefined, { DISABLE_UPDATES: '0' }),
    ).toMatchObject({ autoUpdate: 'enabled' });
  });

  it('reports unknown when no settings document can be read', () => {
    expect(evaluateClaudeAutoUpdate('standalone-binary', undefined, undefined, {}).autoUpdate).toBe('unknown');
  });

  it('reads the release channel from settings when the user pinned one', async () => {
    const install = await service({
      readFile: fakeFiles({
        ...nativeConfig,
        [join(HOME, '.claude', 'settings.json')]: { autoUpdatesChannel: 'stable' },
      }),
    }).inspect(candidate({ realPath: join(HOME, '.local/share/claude/versions/2.1.263') }));
    expect(install?.channel).toBe('stable');
    expect(install?.releaseChannel).toBe('stable');
  });

  it('follows the latest line by default, the way the native installer does', async () => {
    const install = await service().inspect(
      candidate({ realPath: join(HOME, '.local/share/claude/versions/2.1.263') }),
    );
    expect(install?.channel).toBeUndefined();
    expect(install?.releaseChannel).toBe('preview');
  });
});

describe('Claude release channel', () => {
  it('maps the native channel setting for the native installer and a standalone binary', () => {
    expect(claudeReleaseChannel('native-installer', undefined, 'stable')).toBe('stable');
    expect(claudeReleaseChannel('native-installer', undefined, 'latest')).toBe('preview');
    expect(claudeReleaseChannel('native-installer', undefined, 'rc')).toBe('preview');
    expect(claudeReleaseChannel('native-installer', undefined, undefined)).toBe('preview');
    expect(claudeReleaseChannel('standalone-binary', undefined, 'stable')).toBe('stable');
  });

  it('follows what a package manager recipe installs, and nothing it cannot evidence', () => {
    // The npm recipe installs the `latest` dist-tag whatever settings say.
    expect(claudeReleaseChannel('npm-global', '@anthropic-ai/claude-code', 'stable')).toBe('preview');
    expect(claudeReleaseChannel('brew', 'claude-code@latest', undefined)).toBe('preview');
    expect(claudeReleaseChannel('brew', 'claude-code', undefined)).toBeUndefined();
  });
});

describe('Claude update recipes', () => {
  const distribution = service();
  const install = {
    provider: 'claude' as const,
    executable: '/Users/test/.local/bin/claude',
    realPath: '/Users/test/.local/share/claude/versions/2.1.263',
    method: 'native-installer' as const,
    autoUpdate: 'enabled' as const,
    detectedAt: '2026-09-06T00:00:00.000Z',
    warnings: [],
  };

  it('runs the vendor updater for native and standalone installs', () => {
    expect(distribution.recipeFor(install)).toEqual({
      kind: 'native-self-update',
      argv: ['/Users/test/.local/bin/claude', 'update'],
    });
    expect(distribution.recipeFor({ ...install, method: 'standalone-binary' })).toEqual({
      kind: 'native-self-update',
      argv: ['/Users/test/.local/bin/claude', 'update'],
    });
  });

  it('hands npm and Homebrew installs back to their package manager', () => {
    expect(
      distribution.recipeFor({ ...install, method: 'npm-global', packageName: '@anthropic-ai/claude-code' }),
    ).toEqual({ kind: 'npm-global', package: '@anthropic-ai/claude-code' });
    expect(distribution.recipeFor({ ...install, method: 'brew', packageName: 'claude-code' })).toEqual({
      kind: 'brew',
      name: 'claude-code',
      cask: true,
    });
  });
});
