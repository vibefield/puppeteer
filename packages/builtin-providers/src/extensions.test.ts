import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentHost } from '@vibecook/puppeteer-core';
import { createAgentRuntime, type AgentRuntime } from '@vibecook/puppeteer-runtime';
import { createBuiltinProviders } from './providers.js';

/** Reading an inventory never spawns: a host that is asked to is a failure. */
const host = { spawnTerminal: vi.fn(), automateTerminal: vi.fn() } as unknown as AgentHost;
const made: string[] = [];
const runtimes: AgentRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose?.()));
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function write(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(content));
}

describe('built-in extension capabilities', () => {
  it('composes an extension inventory for every agent but ACP and Copilot', () => {
    const withExtensions = createBuiltinProviders()
      .filter((provider) => provider.extensions)
      .map((provider) => provider.descriptor.id)
      .sort();
    expect(withExtensions).toEqual(['antigravity', 'claude', 'codex', 'grok', 'hermes', 'kimi', 'opencode', 'pi']);
  });

  it('reads the native default through the runtime from the home it was given, never the process home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'builtin-extensions-'));
    made.push(home);
    await write(join(home, '.claude.json'), {
      mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
    });
    await write(join(home, '.claude', 'settings.json'), {});
    const runtime = createAgentRuntime({
      host,
      defaultCwd: home,
      // An executable that does not exist, so a broken home seam could never start the machine's Codex.
      providers: createBuiltinProviders({ home, executables: { codex: join(home, 'no-codex') } }),
      profiles: {
        store: { load: async () => undefined, save: async () => {} },
        rootsDirectory: join(home, 'profiles'),
      },
    });
    runtimes.push(runtime);

    expect(
      runtime
        .extensionProviders()
        .map((provider) => provider.id)
        .sort(),
    ).toEqual(['antigravity', 'claude', 'codex', 'grok', 'hermes', 'kimi', 'opencode', 'pi']);
    const inventory = await runtime.extensionInventory('claude');
    expect(inventory).toMatchObject({
      provider: 'claude',
      profileId: 'claude:native-default',
      items: [{ kind: 'mcp-server', id: 'linear', target: 'https://mcp.linear.app/mcp' }],
    });
    // The home holds no `.codex`, so Codex's native default answers before any Codex process starts.
    expect(await runtime.extensionInventory('codex')).toMatchObject({ status: 'not-found', provider: 'codex' });
    // The file readers look only under the home they were given. Grok borrows Claude Code's servers from it;
    // the others find nothing there.
    expect(await runtime.extensionInventory('grok')).toMatchObject({
      provider: 'grok',
      items: [{ kind: 'mcp-server', id: 'claude:linear', origin: 'borrowed', lender: 'claude', shared: true }],
    });
    for (const provider of ['antigravity', 'hermes', 'kimi', 'opencode', 'pi']) {
      expect(await runtime.extensionInventory(provider)).toMatchObject({ provider, items: [] });
    }
    expect(await runtime.extensionInventory('copilot')).toMatchObject({ status: 'unsupported' });
    expect(host.spawnTerminal).not.toHaveBeenCalled();
  });

  it("runs an act through Claude Code's own command, in the clean environment, and decides by reading again", async () => {
    const home = await mkdtemp(join(tmpdir(), 'builtin-extension-acts-'));
    made.push(home);
    const appState = join(home, '.claude.json');
    await write(appState, {
      mcpServers: {
        linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
        postgres: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] },
      },
    });
    await write(join(home, '.claude', 'settings.json'), {});
    // Stands in for `claude mcp remove`: never the machine's Claude.
    const run = vi.fn(
      async (request: { argv: readonly string[]; env: Record<string, string>; onOutput(chunk: string): void }) => {
        request.onOutput('Removed MCP server linear from user config\n');
        await write(appState, {
          mcpServers: { postgres: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] } },
        });
        return { exitCode: 0 };
      },
    );
    const runtime = createAgentRuntime({
      host,
      defaultCwd: home,
      providers: createBuiltinProviders({
        home,
        executables: { claude: join(home, 'no-claude'), codex: join(home, 'no-codex') },
      }),
      profiles: {
        store: { load: async () => undefined, save: async () => {} },
        rootsDirectory: join(home, 'profiles'),
      },
      extensions: { run },
    });
    runtimes.push(runtime);
    const target = { kind: 'mcp-server' as const, id: 'linear' };

    // Claude has no switch for a whole profile: only removal, which says what it takes
    expect(await runtime.planExtensionAct({ providerId: 'claude', target, act: 'disable' })).toMatchObject({
      available: false,
      reason: 'no-command',
    });
    expect(await runtime.planExtensionAct({ providerId: 'claude', target, act: 'remove' })).toMatchObject({
      available: true,
      display: `${join(home, 'no-claude')} mcp remove --scope user linear`,
      reaches: ['definition', 'sign-in'],
    });
    const output: string[] = [];
    const receipt = await runtime.runExtensionAct({
      providerId: 'claude',
      target,
      act: 'remove',
      onOutput: (chunk) => output.push(chunk),
    });
    expect(receipt).toMatchObject({
      provider: 'claude',
      profileId: 'claude:native-default',
      status: 'changed',
      message: 'removed',
      exitCode: 0,
    });
    expect(output).toEqual(['Removed MCP server linear from user config\n']);
    // the native default binds no root variable: Claude finds its own home
    expect(run.mock.calls[0]?.[0].env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(await runtime.extensionInventory('claude')).toMatchObject({
      items: [{ kind: 'mcp-server', id: 'postgres' }],
    });
    // an act on what the profile does not hold never runs
    expect(await runtime.runExtensionAct({ providerId: 'claude', target, act: 'remove' })).toMatchObject({
      status: 'unavailable',
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(host.spawnTerminal).not.toHaveBeenCalled();
  });
});
