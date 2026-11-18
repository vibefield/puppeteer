import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  InstalledAgentSchema,
  InstallRecipeSchema,
  UpdateRecipeSchema,
  type InstallCandidate,
  type InstalledAgent,
} from '@vibefield/puppeteer-core';
import { describe, expect, it } from 'vitest';
import {
  classifyOpenCodeCandidate,
  createOpenCodeDistributionService,
  OPENCODE_DISTRIBUTION_PROVIDER,
  OPENCODE_UPGRADE_ARGUMENTS,
  openCodeAutoUpdateState,
  readOpenCodeAutoUpdateConfig,
} from './distribution.js';

const candidate = (overrides: Partial<InstallCandidate> & Pick<InstallCandidate, 'realPath'>): InstallCandidate => ({
  executable: overrides.executable ?? '/home/tester/.opencode/bin/opencode',
  origin: overrides.origin ?? 'path',
  ...overrides,
});

// Native output captured 2026-09-06 on OpenCode 1.18.23: a bare version.
const versionOutput = '1.18.23\n';

const missingConfig = async (): Promise<string> => {
  throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
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
  const state = (document: string | undefined, version?: string, env: NodeJS.ProcessEnv = {}) =>
    openCodeAutoUpdateState({
      config: document === undefined ? { kind: 'absent' } : readOpenCodeAutoUpdateConfig(document),
      version,
      method: 'standalone-binary',
      env,
    });

  it('reads the config key without judging it', () => {
    expect(readOpenCodeAutoUpdateConfig('{"autoupdate":true}')).toEqual({ kind: 'value', value: true });
    expect(readOpenCodeAutoUpdateConfig('{"autoupdate":"notify"}')).toEqual({ kind: 'value', value: 'notify' });
    expect(readOpenCodeAutoUpdateConfig('{"mcp":{}}')).toEqual({ kind: 'absent' });
    expect(readOpenCodeAutoUpdateConfig('not json')).toEqual({ kind: 'unreadable' });
    expect(readOpenCodeAutoUpdateConfig('[]')).toEqual({ kind: 'unreadable' });
  });

  // Upstream v1.18.16 cli/upgrade.ts: false or OPENCODE_DISABLE_AUTOUPDATE returns early, "notify" only reports,
  // and anything else — `true` or no key — falls through to Installation.upgrade for a patch release.
  it('reads 1.18.x as self-updating unless the config or the environment turns it off', () => {
    for (const version of ['1.18.16', '1.18.35']) {
      expect(state(undefined, version), `missing config at ${version}`).toBe('enabled');
      expect(state('{"mcp":{}}', version), `no key at ${version}`).toBe('enabled');
      expect(state('{"autoupdate":true}', version)).toBe('enabled');
      expect(state('{"autoupdate":false}', version)).toBe('disabled');
      expect(state('{"autoupdate":"notify"}', version)).toBe('disabled');
      expect(state('{"autoupdate":"yes"}', version)).toBe('unknown');
      expect(state('not json', version)).toBe('unknown');
      for (const flag of ['1', 'true', 'TRUE']) {
        expect(state('{"autoupdate":true}', version, { OPENCODE_DISABLE_AUTOUPDATE: flag })).toBe('disabled');
        expect(state(undefined, version, { OPENCODE_DISABLE_AUTOUPDATE: flag })).toBe('disabled');
      }
      expect(state(undefined, version, { OPENCODE_DISABLE_AUTOUPDATE: '0' })).toBe('enabled');
    }
  });

  it('leaves a 1.18.x install unknown when the install method could not be classified', () => {
    // Upstream returns before upgrading when its own method probe finds nothing; path evidence cannot stand in.
    expect(openCodeAutoUpdateState({ config: { kind: 'absent' }, version: '1.18.16', method: 'unknown' })).toBe(
      'unknown',
    );
  });

  // Upstream v1.19.0 cli/upgrade.ts: "Checking never installs anything."
  it('reads every config state as disabled from 1.19.0', () => {
    for (const version of ['1.19.0', '1.19.5', '1.20.0', '2.0.0']) {
      expect(state(undefined, version), `missing config at ${version}`).toBe('disabled');
      expect(state('{"mcp":{}}', version), `no key at ${version}`).toBe('disabled');
      expect(state('{"autoupdate":true}', version)).toBe('disabled');
      expect(state('{"autoupdate":false}', version)).toBe('disabled');
      expect(state('{"autoupdate":"notify"}', version)).toBe('disabled');
      expect(state('{"autoupdate":"yes"}', version)).toBe('disabled');
      expect(state('not json', version)).toBe('disabled');
    }
  });

  it('trusts only the explicit off switches without a version the evidence covers', () => {
    for (const version of [undefined, '1.17.9']) {
      expect(state(undefined, version)).toBe('unknown');
      expect(state('{"autoupdate":true}', version)).toBe('unknown');
      expect(state('{"autoupdate":false}', version)).toBe('disabled');
      expect(state('{"autoupdate":"notify"}', version)).toBe('disabled');
      expect(state(undefined, version, { OPENCODE_DISABLE_AUTOUPDATE: '1' })).toBe('disabled');
    }
  });

  it('applies the installed version the native probe reported', async () => {
    const config = async () => '{"autoupdate":true}';
    const old = await service({ readConfigFile: config }).inspect(
      candidate({ realPath: '/home/tester/.opencode/bin/opencode' }),
    );
    expect(old).toMatchObject({ version: '1.18.23', autoUpdate: 'enabled' });
    const current = await service({
      readConfigFile: config,
      exec: async () => ({ stdout: '1.19.5\n', stderr: '' }),
    }).inspect(candidate({ realPath: '/home/tester/.opencode/bin/opencode' }));
    expect(current).toMatchObject({ version: '1.19.5', autoUpdate: 'disabled' });
  });

  it('reads a missing config file as the default on both lines', async () => {
    const at = (stdout: string) =>
      service({ exec: async () => ({ stdout, stderr: '' }) }).inspect(
        candidate({ realPath: '/home/tester/.opencode/bin/opencode' }),
      );
    expect(await at('1.18.16\n')).toMatchObject({ autoUpdate: 'enabled' });
    expect(await at('1.19.5\n')).toMatchObject({ autoUpdate: 'disabled' });
  });

  it('keeps an unreadable config unknown on 1.18.x', async () => {
    const install = await service({
      readConfigFile: async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    }).inspect(candidate({ realPath: '/home/tester/.opencode/bin/opencode' }));
    expect(install).toMatchObject({ version: '1.18.23', autoUpdate: 'unknown' });
  });

  it('reads OPENCODE_DISABLE_AUTOUPDATE from the environment the service was given', async () => {
    const install = await service({ env: { OPENCODE_DISABLE_AUTOUPDATE: 'true' } }).inspect(
      candidate({ realPath: '/home/tester/.opencode/bin/opencode' }),
    );
    expect(install).toMatchObject({ version: '1.18.23', autoUpdate: 'disabled' });
  });

  it('merges the global config files in upstream order, the last autoupdate winning', async () => {
    const files = (contents: Record<string, string>) => async (path: string) => {
      const text = contents[basename(path)];
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return text;
    };
    const at = (contents: Record<string, string>) =>
      service({ readConfigFile: files(contents) }).inspect(
        candidate({ realPath: '/home/tester/.opencode/bin/opencode' }),
      );
    expect(await at({ 'opencode.jsonc': '{"autoupdate":false}' })).toMatchObject({ autoUpdate: 'disabled' });
    expect(await at({ 'config.json': '{"autoupdate":false}' })).toMatchObject({ autoUpdate: 'disabled' });
    expect(await at({ 'config.json': '{"autoupdate":false}', 'opencode.json': '{"autoupdate":true}' })).toMatchObject({
      autoUpdate: 'enabled',
    });
    expect(
      await at({ 'opencode.json': '{"autoupdate":true}', 'opencode.jsonc': '{"autoupdate":"notify"}' }),
    ).toMatchObject({ autoUpdate: 'disabled' });
    expect(await at({ 'opencode.json': '{"mcp":{}}' })).toMatchObject({ autoUpdate: 'enabled' });
    expect(
      await at({
        'config.json': '{"autoupdate":true}',
        'opencode.json': '// overrides the default\n{"autoupdate":false,}',
        'opencode.jsonc': '{/* final override */"autoupdate":"notify",}',
      }),
    ).toMatchObject({ autoUpdate: 'disabled' });
    expect(
      await at({
        'opencode.json': '{"autoupdate":false}',
        'opencode.jsonc': '{/* final override */"autoupdate":true,}',
      }),
    ).toMatchObject({ autoUpdate: 'enabled' });
    expect(
      await at({
        'opencode.json': '{"autoupdate":false}',
        'opencode.jsonc': '{"autoupdate":true,,}',
      }),
    ).toMatchObject({ autoUpdate: 'unknown' });
  });

  it('reads JSONC comments and trailing commas without changing strings', () => {
    const document = [
      '{',
      '  // "autoupdate": true,',
      '  "mcp": {"example": {"url": "https://example.test/a/*literal*/,}"}},',
      '  "autoupdate": /* preserve the actual switch */ false,',
      '}',
    ].join('\r');
    expect(readOpenCodeAutoUpdateConfig(document)).toEqual({ kind: 'value', value: false });
    expect(state(document, '1.18.16')).toBe('disabled');
  });

  it('does not use a partial document recovered from invalid JSONC', () => {
    for (const document of [
      '{"autoupdate":false,,}',
      '{"autoupdate":false, "mcp": {,}}',
      '{"autoupdate":false} trailing',
      '{"autoupdate":false /* unterminated',
    ]) {
      expect(readOpenCodeAutoUpdateConfig(document)).toEqual({ kind: 'unreadable' });
      expect(state(document, '1.18.16')).toBe('unknown');
    }
  });

  it('does not infer an off switch before OpenCode resolves config substitutions', () => {
    for (const document of [
      '{"autoupdate":"{env:UPDATE_MODE}"}',
      '{"autoupdate":false,"mcp":{"example":{"url":"{env:MCP_URL}"}}}',
      '{"{env:CONFIG_KEY}":false}',
      '{"autoupdate":false,"instructions":["{file:instructions.txt}"]}',
    ]) {
      expect(readOpenCodeAutoUpdateConfig(document)).toEqual({ kind: 'unreadable' });
      expect(state(document, '1.18.16')).toBe('unknown');
      expect(state(document, '1.19.0')).toBe('disabled');
    }
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
    expect(seen).toEqual(
      ['config.json', 'opencode.json', 'opencode.jsonc'].map((name) =>
        join('/home/tester/.xdg-config', 'opencode', name),
      ),
    );
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
    expect(seen).toEqual(
      ['config.json', 'opencode.json', 'opencode.jsonc'].map((name) =>
        join('/home/tester', '.config', 'opencode', name),
      ),
    );
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
      // A missing config on 1.18.x is the self-installing default.
      autoUpdate: 'enabled',
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

  it('never asks the upgrade command for --major, which would move a 1.x install to 2.x', () => {
    expect(OPENCODE_UPGRADE_ARGUMENTS).toEqual(['upgrade']);
    for (const method of ['standalone-binary', 'brew', 'unknown'] as const) {
      const recipe = service().recipeFor(installed({ method }));
      expect(recipe.kind).toBe('native-self-update');
      expect(recipe.kind === 'native-self-update' ? recipe.argv : []).not.toContain('--major');
    }
  });

  it('hands npm installs back to the package manager', () => {
    expect(service().recipeFor(installed({ method: 'npm-global', packageName: 'opencode-ai' }))).toEqual({
      kind: 'npm-global',
      package: 'opencode-ai',
    });
  });
});

describe('OpenCode first install', () => {
  it("runs the vendor's documented installer and looks where it leaves the agent", () => {
    expect(OPENCODE_DISTRIBUTION_PROVIDER.installDirectories).toEqual(['.opencode/bin']);
    expect(InstallRecipeSchema.parse(createOpenCodeDistributionService().installRecipe?.())).toEqual({
      kind: 'installer-script',
      url: 'https://opencode.ai/install',
    });
  });
});

describe('OpenCode 2.x installs', () => {
  it('names the 2.x release line in a warning and claims no version for it', async () => {
    const install = await service({ exec: async () => ({ stdout: 'opencode v2.2.5\n', stderr: '' }) }).inspect(
      candidate({ realPath: '/home/tester/.opencode/bin/opencode' }),
    );
    expect(InstalledAgentSchema.parse(install)).toBeTruthy();
    expect(install?.version).toBeUndefined();
    expect(install?.warnings).toEqual([
      expect.stringContaining('OpenCode 2.2.5 is the 2.x release line, which this adapter does not support'),
    ]);
  });

  it('claims no auto-update state from the 1.x rules, whatever the config or environment says', async () => {
    const disabled = await service({
      exec: async () => ({ stdout: 'opencode v2.2.5\n', stderr: '' }),
      readConfigFile: async () => '{ "autoupdate": false }',
      env: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
    }).inspect(candidate({ realPath: '/home/tester/.opencode/bin/opencode' }));
    expect(disabled?.autoUpdate).toBe('unknown');
  });

  it('offers no upgrade command for a 2.x install, only a manual recipe', async () => {
    const twoLine = service({ exec: async () => ({ stdout: 'opencode v2.2.5\n', stderr: '' }) });
    const install = await twoLine.inspect(candidate({ realPath: '/home/tester/.opencode/bin/opencode' }));
    expect(install).toBeDefined();
    // The runtime keeps the install as a record, so the recipe comes from the record alone.
    const recipe = service().recipeFor(JSON.parse(JSON.stringify(install)) as InstalledAgent);
    expect(UpdateRecipeSchema.parse(recipe)).toMatchObject({ kind: 'manual' });
    expect(
      service().recipeFor(installed({ method: 'npm-global', packageName: 'opencode-ai', warnings: install!.warnings })),
    ).toMatchObject({ kind: 'manual' });
    // A 1.x install whose version could not be read keeps its upgrade.
    expect(service().recipeFor(installed({ warnings: ['opencode --version failed: timeout'] }))).toMatchObject({
      kind: 'native-self-update',
    });
  });
});
