/** Native TUI interaction survey; semantic assertions read durable wire records. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { describe, expect, it } from 'vitest';
import { createKimiTuiSession } from './driver.js';
import { resolveKimiExecutable } from './detection.js';
import { isolatedKimiLiveEnvironment, startKimiLoopbackProvider } from './test-support/live-model.js';
import { KimiLivePtyHost } from './test-support/live-pty-host.js';
import { kimiRecord } from './normalization/types.js';
import { waitFor } from './test-support/live-harness.js';

const live = process.env.KIMI_LIVE === '1';

describe.runIf(live)('Kimi native TUI interactions (live)', () => {
  for (const scenario of ['permission-deny', 'permission-allow', 'question-answer', 'escape-interrupt'] as const) {
    it(
      scenario,
      async () => {
        const startedAt = new Date().toISOString();
        const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-kimi-interaction-')));
        const cwd = join(root, 'workspace');
        const home = join(root, 'home');
        const scratch = join(cwd, 'scratch');
        mkdirSync(scratch, { recursive: true });
        writeFileSync(join(scratch, 'sentinel'), 'preserve on deny');
        const provider = await startKimiLoopbackProvider(
          scenario === 'escape-interrupt'
            ? { pauseAfterFirstChunk: true }
            : {
                tool: scenario.startsWith('permission-')
                  ? {
                      name: 'Bash',
                      arguments: {
                        command: `rm -rf '${scratch}'`,
                        description: 'Remove the disposable test scratch directory',
                      },
                    }
                  : {
                      name: 'AskUserQuestion',
                      arguments: {
                        questions: [
                          { question: 'SURFACE_KIMI_QUESTION', options: [{ label: 'Alpha' }, { label: 'Beta' }] },
                        ],
                      },
                    },
              },
        );
        const host = new KimiLivePtyHost();
        let session: Awaited<ReturnType<typeof createKimiTuiSession>> | undefined;
        let projection: ReturnType<typeof projectAgentEvents> | undefined;
        try {
          session = await createKimiTuiSession({
            cwd,
            host,
            executable: resolveKimiExecutable(),
            env: isolatedKimiLiveEnvironment(root, home, provider.baseUrl),
            kimiHome: home,
            permissionMode: 'manual',
            pollIntervalMs: 25,
            promptConfirmationTimeoutMs: 30_000,
          });
          projection = projectAgentEvents(session);
          const records = () =>
            projection!.envelopes.flatMap(({ nativeEvent }) => {
              const record = kimiRecord(kimiRecord(nativeEvent)?.record);
              return record ? [record] : [];
            });
          expect(await session.services.prompt.submit({ text: `Exercise ${scenario} once.` })).toMatchObject({
            status: 'confirmed',
          });
          if (scenario === 'escape-interrupt') {
            await waitFor(
              () => host.output(session!.runtimeSessionId).includes('SURFACE_KIMI_'),
              'streaming native TUI',
            );
            await host.automateTerminal(session.runtimeSessionId, { kind: 'text', text: '\x1b' });
          } else {
            await waitFor(
              () => records().some((record) => record.type === 'interaction.request'),
              'durable interaction request',
            );
            await waitFor(
              () =>
                host
                  .output(session!.runtimeSessionId)
                  .includes(scenario === 'question-answer' ? 'SURFACE_KIMI_QUESTION' : 'scratch'),
              'native interaction overlay',
            );
            await host.automateTerminal(session.runtimeSessionId, {
              kind: 'text',
              text: scenario === 'permission-deny' ? '\x1b' : '\r',
            });
            if (scenario === 'question-answer') {
              await waitFor(
                () => host.output(session!.runtimeSessionId).includes('Ready to submit your answers?'),
                'native answer review',
              );
              await host.automateTerminal(session.runtimeSessionId, { kind: 'text', text: '\r' });
            }
          }
          await waitFor(
            () => projection!.envelopes.some(({ event }) => ['turn:completed', 'turn:failed'].includes(event.type)),
            'terminal turn',
          );
          if (scenario.startsWith('permission-')) {
            expect(
              projection.envelopes
                .filter(({ event }) => event.type === 'interaction:permission-resolved')
                .map(({ event }) => event),
            ).toEqual([expect.objectContaining({ outcome: scenario === 'permission-deny' ? 'denied' : 'allowed' })]);
          } else if (scenario === 'question-answer') {
            expect(records()).toContainEqual(
              expect.objectContaining({
                type: 'interaction.resolved',
                response: { answers: { SURFACE_KIMI_QUESTION: 'Alpha' }, method: 'enter' },
              }),
            );
          } else {
            expect(records()).toContainEqual(
              expect.objectContaining({ type: 'turn.cancel', reason: 'user_cancelled' }),
            );
            expect(records()).toContainEqual(
              expect.objectContaining({ type: 'turn.step.interrupted', reason: 'aborted' }),
            );
            expect(
              projection.envelopes.filter(({ event }) => event.type === 'turn:completed').map(({ event }) => event),
            ).toEqual([expect.objectContaining({ stopReason: 'cancelled' })]);
          }
          expect(existsSync(join(scratch, 'sentinel'))).toBe(scenario !== 'permission-allow');
          const directory = process.env.KIMI_INTERACTION_CAPTURE_DIR;
          if (directory) {
            const retained = new Set([
              'interaction.request',
              'interaction.resolved',
              'turn.prompt',
              'turn.cancel',
              'turn.step.start',
              'turn.step.interrupted',
              'prompt.aborted',
              'turn.ended',
              'context.append_loop_event',
            ]);
            const selected = [
              ...new Set(
                records()
                  .filter((record) => retained.has(String(record.type)))
                  .map((record) =>
                    JSON.stringify(record, (key, value) =>
                      key === 'action'
                        ? '<redacted:action>'
                        : typeof value === 'string'
                          ? value.split(root).join('<redacted:root>')
                          : value,
                    ),
                  ),
              ),
            ].map((json) => JSON.parse(json));
            mkdirSync(directory, { recursive: true });
            writeFileSync(
              join(directory, `${scenario}.json`),
              `${JSON.stringify({ schemaVersion: 1, scenario, startedAt, completedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, artifactSha256: `sha256:${createHash('sha256').update(readFileSync(resolveKimiExecutable())).digest('hex')}`, scope: 'selected durable records from the native TUI; not a promotion receipt', records: selected }, null, 2)}\n`,
            );
          }
        } catch (cause) {
          throw new Error(
            `${scenario}: events=${JSON.stringify(projection?.envelopes.map(({ event }) => event.type))} tui=${JSON.stringify(session ? host.output(session.runtimeSessionId).slice(-6_000) : '')}`,
            { cause },
          );
        } finally {
          projection?.dispose();
          if (session) await host.disposeTerminal(session.runtimeSessionId);
          await session?.dispose();
          await host.dispose();
          await provider.close();
          rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
        }
      },
      90_000,
    );
  }
});
