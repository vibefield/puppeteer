/**
 * Opt-in, zero-inference: creates a native thread only inside a throwaway HOME and CODEX_HOME with no
 * credentials and no provider, run by the exact codex PUPPETEER_CODEX_BIN names.
 *
 *   PUPPETEER_LIVE_MODELS=1 PUPPETEER_CODEX_BIN=/absolute/path/to/codex pnpm exec vitest run src/launch/models.live.test.ts
 */

import { expect, it } from 'vitest';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { createCodexModelService } from '../services/models.js';
import { createCodexLiveProfile, requireCodexLiveExecutable } from '../test-support/live-profile.js';
import { prepareCodexTuiSession } from './tui-session.js';

it.skipIf(process.env.PUPPETEER_LIVE_MODELS !== '1')(
  'native thread startup acknowledges the discovered model and requested effort',
  async () => {
    const executable = requireCodexLiveExecutable('PUPPETEER_LIVE_MODELS');
    const profile = await createCodexLiveProfile('codex-model-start-', 'none');
    const { cwd, environment: env } = profile;
    try {
      const result = await createCodexModelService({ executable, env: { ...process.env, ...env } }).discover({
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
        executable,
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
      await profile.dispose();
    }
  },
  90_000,
);
