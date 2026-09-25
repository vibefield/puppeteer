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
});
