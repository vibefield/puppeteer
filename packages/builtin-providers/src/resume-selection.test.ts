import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defineModelService,
  type AgentHost,
  type AgentModelChoice,
  type AgentModelDiscoveryContext,
  type TerminalSpec,
} from '@vibefield/puppeteer-core';
import { createAgentRuntime, type AgentProvider, type AgentRuntime } from '@vibefield/puppeteer-runtime';
import { createBuiltinProviders, type BuiltinProviderOptions } from './providers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function scratch(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'builtin-resume-selection-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

/**
 * The builtin providers with discovery answered from a fixed catalog: the
 * runtime's resume, the adapter's real translation, and its real launch recipe
 * are what run. Executables that are not given cannot start.
 */
function compose(
  executables: NonNullable<BuiltinProviderOptions['executables']>,
  models: Record<string, AgentModelChoice[]>,
  cwd: string,
) {
  const missing = Object.fromEntries(
    ['claude', 'codex', 'grok', 'kimi', 'opencode', 'hermes', 'antigravity', 'copilot', 'pi'].map((id) => [
      id,
      join(cwd, 'missing', id),
    ]),
  );
  const discover = vi.fn();
  const providers = createBuiltinProviders({ executables: { ...missing, ...executables } }).map(
    (provider): AgentProvider => {
      const real = provider.models;
      const choices = models[provider.descriptor.id];
      if (!real || !choices) return provider;
      return {
        ...provider,
        models: defineModelService({
          provider: real.provider,
          discover: async (context: AgentModelDiscoveryContext) => {
            discover(provider.descriptor.id, context);
            return {
              status: 'available',
              catalog: {
                provider: provider.descriptor.id,
                cwd: context.cwd,
                ...(context.profile ? { profileId: context.profile.id } : {}),
                observedAt: new Date().toISOString(),
                source: { kind: 'native-protocol', freshness: 'unknown' },
                completeness: 'complete',
                customModels: false,
                models: choices,
              },
            };
          },
          toAgentOptions: (selection, catalog) => real.toAgentOptions(selection, catalog),
        }),
      };
    },
  );
  const launches: TerminalSpec[] = [];
  const host: AgentHost = {
    async spawnTerminal(spec) {
      launches.push(spec);
      // The recipe is the witness; nothing native is started.
      throw new Error('terminal withheld by the test');
    },
    async automateTerminal() {
      return { accepted: true };
    },
  };
  const runtime: AgentRuntime = createAgentRuntime({ defaultCwd: cwd, providers, host });
  cleanups.push(async () => {
    await runtime.dispose();
  });
  return { runtime, discover, launches };
}

describe('builtin agents and a resume that carries a model selection', () => {
  it('declare it where the native resume takes the launch’s model options, and nowhere else', () => {
    const declared = Object.fromEntries(
      createBuiltinProviders().flatMap((provider) =>
        provider.models ? [[provider.descriptor.id, provider.models.provider.resumeSelection]] : [],
      ),
    );
    expect(declared).toEqual({
      claude: true,
      codex: true,
      acp: undefined,
      grok: true,
      kimi: true,
      opencode: false,
      antigravity: true,
      copilot: true,
      pi: true,
      hermes: false,
    });
  });

  it('resumes Claude with --resume, --model and --effort, in the root the continuation restores', async () => {
    const root = await scratch();
    const cwd = join(root, 'work');
    const configDir = join(root, 'claude-config');
    const sessionId = '64a61b19-f4d8-4f96-ba56-07024b470815';
    await mkdir(cwd);
    await mkdir(join(configDir, 'projects', 'work'), { recursive: true });
    await writeFile(join(configDir, 'projects', 'work', `${sessionId}.jsonl`), '');
    // The launch preflight reads the real help of the Claude Code the adapter is pinned to (2.1.308 since #38):
    // --resume, --model and --effort all advertised.
    const help = await readFile(
      fileURLToPath(new URL('../../adapter-claude/src/launch/__fixtures__/claude-help-2.1.308.txt', import.meta.url)),
      'utf8',
    );
    const claude = join(root, 'claude.mjs');
    await writeFile(
      claude,
      `process.stdout.write(process.argv[2] === '--version' ? '2.1.308 (Claude Code)\\n' : ${JSON.stringify(help)});\n`,
    );
    const { runtime, discover, launches } = compose(
      { claude },
      {
        claude: [
          {
            id: 'sonnet',
            label: 'Sonnet',
            controls: [
              {
                id: 'effort',
                label: 'Effort',
                role: 'effort',
                values: [
                  { id: 'high', label: 'high' },
                  { id: 'max', label: 'max' },
                ],
              },
            ],
          },
        ],
      },
      cwd,
    );
    const resumed = await runtime.resume({
      continuation: {
        providerId: 'claude',
        nativeSessionId: sessionId,
        implementation: 'native',
        state: JSON.stringify({ version: 2, configDir }),
      },
      modelSelection: { modelId: 'sonnet', controls: { effort: 'max' } },
    });
    expect(resumed).toHaveProperty('error');
    expect(discover).toHaveBeenCalledWith('claude', expect.objectContaining({ cwd }));
    expect(launches).toHaveLength(1);
    const args = launches[0]!.args ?? [];
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', sessionId]);
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'sonnet']);
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'max']);
    expect(args).not.toContain('--session-id');
    expect(launches[0]!.env).toMatchObject({ CLAUDE_CONFIG_DIR: configDir });
  });

  it.each([
    ['opencode', 'OpenCode'],
    ['hermes', 'Hermes'],
  ])('refuses a %s resume that carries one before discovery, rather than resume without it', async (id, label) => {
    const cwd = await scratch();
    const { runtime, discover, launches } = compose(
      {},
      { [id]: [{ id: JSON.stringify(['native-provider', 'native-model']), label: 'Native', controls: [] }] },
      cwd,
    );
    expect(
      await runtime.resume({
        continuation: { providerId: id, nativeSessionId: 'native-session', implementation: 'native' },
        modelSelection: { modelId: JSON.stringify(['native-provider', 'native-model']) },
      }),
    ).toMatchObject({
      error: {
        code: 'AGENT_LAUNCH_REFUSED',
        message: `${label} cannot start a resumed session at a model selection; resume without one.`,
        refusal: { code: 'INVALID_MODEL_SELECTION' },
      },
    });
    expect(discover).not.toHaveBeenCalled();
    expect(launches).toEqual([]);
  });
});
