import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { projectAgentEvents } from '@vibecook/puppeteer-testing';
import { createCodexModelService } from '../services/models.js';
import { prepareCodexTuiSession } from './tui-session.js';

/** Zero-inference check: creates a native thread only inside a disposable Codex profile. */
it.skipIf(process.env.PUPPETEER_LIVE_MODELS !== '1')(
  'native thread startup acknowledges the discovered model and requested effort',
  async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'codex-model-start-')));
    const env = { CODEX_HOME: cwd };
    try {
      const result = await createCodexModelService({ env: { ...process.env, ...env } }).discover({
        cwd,
        timeoutMs: 40_000,
      });
      if (result.status !== 'available') throw new Error(result.message);
      const choice = result.catalog.models.find((model) =>
        model.controls.some(
          (control) => control.id === 'effort' && control.values.some((value) => value.id === 'high'),
        ),
      );
      expect(choice).toBeDefined();
      const prepared = await prepareCodexTuiSession({
        cwd,
        model: choice!.id,
        effort: 'high',
        env,
        appServerEnv: env,
        host: {
          async spawnTerminal() {
            throw new Error('Preparation does not need a terminal.');
          },
          async automateTerminal() {
            throw new Error('No inference allowed.');
          },
        },
      });
      try {
        const session = await prepared.adopt('metadata-only');
        const projection = projectAgentEvents(session);
        try {
          const updates = projection.monitorBatches.flatMap((batch) => batch.updates);
          expect(updates).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                family: 'model',
                value: expect.objectContaining({ providerModelId: choice!.id, intent: 'observed' }),
              }),
              expect.objectContaining({
                family: 'effort',
                value: expect.objectContaining({ value: 'high', intent: 'observed' }),
              }),
            ]),
          );
        } finally {
          projection.dispose();
        }
      } finally {
        await prepared.dispose();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  90_000,
);
