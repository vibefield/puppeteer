import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createBuiltinAgentRuntime } from './runtime.js';

/** Explicit opt-in: native metadata only, no session creation, prompts, or inference. */
it.skipIf(process.env.PUPPETEER_LIVE_MODELS !== '1')(
  'discovers models through the public runtime for every installed agent',
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'puppeteer-live-models-'));
    const runtime = createBuiltinAgentRuntime({
      defaultCwd: cwd,
      profiles: { rootsDirectory: join(cwd, 'profiles') },
      host: {
        async spawnTerminal() {
          throw new Error('Discovery must not open a terminal.');
        },
        async automateTerminal() {
          throw new Error('Discovery must not send input.');
        },
      },
    });
    const results = [];
    try {
      for (const provider of runtime.modelProviders()) {
        const result = await runtime.discoverModels({ agent: provider.id, profileSet: 'native', timeoutMs: 40_000 });
        results.push(result);
        console.info(
          provider.id,
          result.status,
          result.status === 'available'
            ? `${result.catalog.models.length} choices (${result.catalog.source.nativeVersion})`
            : result.code,
        );
      }
      if (process.env.PUPPETEER_MODELS_REPORT)
        await writeFile(process.env.PUPPETEER_MODELS_REPORT, JSON.stringify(results, null, 2) + '\n');
      expect(results).toHaveLength(10);
      for (const result of results) {
        if (result.status === 'requires-session') expect(result.provider).toBe('acp');
        else {
          expect(result.status, JSON.stringify(result)).toBe('available');
          if (result.status === 'available') {
            expect(result.catalog.models.length).toBeGreaterThan(0);
            expect(result.catalog.source.nativeVersion).toMatch(/^\d+\.\d+\.\d+/u);
          }
        }
      }
    } finally {
      await runtime.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  420_000,
);
