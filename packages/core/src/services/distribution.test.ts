import { describe, expect, it } from 'vitest';
import {
  AgentInstallationSchema,
  DistributionFailureSchema,
  DistributionProviderSchema,
  InstallCandidateSchema,
  InstalledAgentSchema,
  InstallReceiptSchema,
  InstallRecipeSchema,
  ReleaseDetectorSchema,
  ReleaseSnapshotSchema,
  UpdateReceiptSchema,
  UpdateRecipeSchema,
} from './distribution.js';

describe('distribution contracts', () => {
  it('accepts a host-discovered candidate and the adapter classification of it', () => {
    expect(
      InstallCandidateSchema.parse({
        executable: '/opt/example/bin/example',
        realPath: '/opt/example/versions/1.2.3/example',
        origin: 'npm-global',
        packageRoot: '/opt/example/lib/node_modules/@example/cli',
      }).origin,
    ).toBe('npm-global');

    const installed = InstalledAgentSchema.parse({
      provider: 'example',
      executable: '/opt/example/bin/example',
      realPath: '/opt/example/versions/1.2.3/example',
      version: '1.2.3',
      method: 'native-installer',
      location: '/opt/example/versions/1.2.3',
      autoUpdate: 'enabled',
      channel: 'stable',
      detectedAt: '2026-09-06T12:00:00.000Z',
      warnings: [],
    });
    expect(AgentInstallationSchema.parse({ ...installed, origin: 'path', active: true }).active).toBe(true);
  });

  it('requires an explicit auto-update verdict and rejects unknown install fields', () => {
    const base = {
      provider: 'example',
      executable: 'example',
      realPath: '/usr/local/bin/example',
      method: 'unknown',
      detectedAt: '2026-09-06T12:00:00.000Z',
      warnings: ['version probe failed'],
    };
    // `autoUpdate` is required: an adapter must say 'unknown' rather than omit
    // the field, so a missing verdict can never read as "not auto-updating".
    expect(InstalledAgentSchema.safeParse(base).success).toBe(false);
    expect(InstalledAgentSchema.safeParse({ ...base, autoUpdate: 'unknown' }).success).toBe(true);
    expect(InstalledAgentSchema.safeParse({ ...base, autoUpdate: 'unknown', pid: 42 }).success).toBe(false);
  });

  it('validates every release detector kind and rejects plaintext endpoints', () => {
    expect(
      ReleaseDetectorSchema.parse({
        kind: 'text',
        id: 'vendor-stable',
        channel: 'stable',
        url: 'https://downloads.example.com/releases/stable',
        versionPattern: '^(\\d+\\.\\d+\\.\\d+)',
      }).kind,
    ).toBe('text');
    expect(
      ReleaseDetectorSchema.safeParse({
        kind: 'github-release',
        id: 'github',
        channel: 'preview',
        url: 'https://api.github.com/repos/example/cli/releases',
        tagPattern: '^v(.+)$',
        titlePattern: '^Example (\\S+)$',
        prerelease: true,
      }).success,
    ).toBe(true);
    expect(
      ReleaseDetectorSchema.safeParse({
        kind: 'npm-registry',
        id: 'npm',
        channel: 'stable',
        package: '@example/cli',
        distTag: 'latest',
      }).success,
    ).toBe(true);
    expect(
      ReleaseDetectorSchema.safeParse({
        kind: 'text',
        id: 'insecure',
        channel: 'stable',
        url: 'http://downloads.example.com/stable',
        versionPattern: '(.+)',
      }).success,
    ).toBe(false);
  });

  it('validates recipes, receipts, and typed failures', () => {
    expect(
      UpdateRecipeSchema.parse({ kind: 'native-self-update', argv: ['/usr/local/bin/example', 'update'] }).kind,
    ).toBe('native-self-update');
    expect(UpdateRecipeSchema.safeParse({ kind: 'brew', name: 'example', cask: true }).success).toBe(true);
    expect(UpdateRecipeSchema.safeParse({ kind: 'native-self-update', argv: [] }).success).toBe(false);

    expect(
      UpdateReceiptSchema.parse({
        provider: 'example',
        status: 'already-current',
        startedAt: '2026-09-06T12:00:00.000Z',
        finishedAt: '2026-09-06T12:00:04.000Z',
        exitCode: 0,
        transcriptPath: '/home/user/.puppeteer/updates/example-1.log',
      }).status,
    ).toBe('already-current');
    expect(
      DistributionFailureSchema.safeParse({
        status: 'unavailable',
        provider: 'example',
        message: 'release detector could not be read',
        retryable: true,
      }).success,
    ).toBe(true);
  });

  it('validates install recipes and receipts: a first install runs no native command, since nothing is installed', () => {
    const script = {
      kind: 'installer-script',
      url: 'https://example.com/install.sh',
    } as const;
    expect(InstallRecipeSchema.parse(script).kind).toBe('installer-script');
    expect(InstallRecipeSchema.safeParse({ kind: 'npm-global', package: '@example/cli' }).success).toBe(true);
    expect(InstallRecipeSchema.safeParse({ kind: 'brew', name: 'example', cask: false }).success).toBe(true);
    expect(InstallRecipeSchema.safeParse({ kind: 'manual', instructions: 'Download the app.' }).success).toBe(true);
    // There is no executable yet for a native command to name.
    expect(InstallRecipeSchema.safeParse({ kind: 'native-self-update', argv: ['example', 'install'] }).success).toBe(
      false,
    );
    expect(InstallRecipeSchema.safeParse({ ...script, url: 'http://example.com/install.sh' }).success).toBe(false);
    // The shell the vendor pipes to, and the commands its script says it needs.
    expect(InstallRecipeSchema.safeParse({ ...script, shell: 'sh', needs: ['node', 'npm'] }).success).toBe(true);
    expect(InstallRecipeSchema.safeParse({ ...script, shell: 'zsh' }).success).toBe(false);
    expect(InstallRecipeSchema.safeParse({ ...script, needs: ['node; rm -rf'] }).success).toBe(false);
    // The members are the update recipe's own: one shape for one command.
    expect(UpdateRecipeSchema.parse(script)).toEqual(InstallRecipeSchema.parse(script));

    const after = {
      provider: 'example',
      executable: '/home/user/.local/bin/example',
      realPath: '/home/user/.local/share/example/versions/1.2.3',
      version: '1.2.3',
      method: 'native-installer',
      autoUpdate: 'unknown',
      detectedAt: '2026-10-29T12:00:09.000Z',
      warnings: [],
    } as const;
    const times = { startedAt: '2026-10-29T12:00:00.000Z', finishedAt: '2026-10-29T12:00:09.000Z' };
    expect(
      InstallReceiptSchema.parse({
        provider: 'example',
        status: 'installed',
        recipe: script,
        after,
        ...times,
        exitCode: 0,
      }).after?.version,
    ).toBe('1.2.3');
    expect(
      InstallReceiptSchema.parse({
        provider: 'example',
        status: 'failed',
        recipe: { kind: 'npm-global', package: '@example/cli' },
        missing: ['npm'],
        ...times,
        message: 'needs npm, which is not on the search path',
      }).missing,
    ).toEqual(['npm']);
    for (const status of ['present', 'not-found', 'unsupported']) {
      expect(InstallReceiptSchema.safeParse({ provider: 'example', status, ...times }).success).toBe(true);
    }
    expect(InstallReceiptSchema.safeParse({ provider: 'example', status: 'updated', ...times }).success).toBe(false);
    expect(InstallReceiptSchema.safeParse({ provider: 'example', status: 'installed', ...times, pid: 1 }).success).toBe(
      false,
    );
  });

  it('binds a distribution provider to its discovery inputs', () => {
    const provider = DistributionProviderSchema.parse({
      id: 'example',
      label: 'Example',
      commands: ['example'],
      npmPackages: ['@example/cli'],
      brewNames: ['example'],
      detectors: [
        {
          kind: 'npm-registry',
          id: 'npm-latest',
          channel: 'stable',
          package: '@example/cli',
          distTag: 'latest',
        },
      ],
      nativeUpdateCheck: false,
    });
    expect(provider.commands).toEqual(['example']);
    // At least one command name: without one there is nothing to search PATH for.
    expect(DistributionProviderSchema.safeParse({ ...provider, commands: [] }).success).toBe(false);
    expect(
      DistributionProviderSchema.safeParse({ ...provider, installDirectories: ['.local/bin', '.kimi-code/bin'] })
        .success,
    ).toBe(true);
    // Install directories stay under the home: never absolute, never written from the shell, never climbing out.
    for (const directory of ['/usr/local/bin', '~/.local/bin', '../bin', '.local/../../bin', '.local//bin', '.', '']) {
      expect(DistributionProviderSchema.safeParse({ ...provider, installDirectories: [directory] }).success).toBe(
        false,
      );
    }
  });

  it('keeps release snapshots attributable to the source that produced them', () => {
    expect(
      ReleaseSnapshotSchema.parse({
        provider: 'example',
        channel: 'stable',
        version: '1.2.4',
        publishedAt: '2026-09-05T09:00:00.000Z',
        url: 'https://github.com/example/cli/releases/tag/v1.2.4',
        fetchedAt: '2026-09-06T12:00:00.000Z',
        source: { kind: 'github-release', id: 'github' },
      }).source.kind,
    ).toBe('github-release');
    expect(
      ReleaseSnapshotSchema.safeParse({
        provider: 'example',
        channel: 'nightly',
        version: '1.2.4',
        fetchedAt: '2026-09-06T12:00:00.000Z',
        source: { kind: 'text', id: 'vendor' },
      }).success,
    ).toBe(false);
  });
});
