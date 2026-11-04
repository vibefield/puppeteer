/** Real attached-TUI interactions: semantic assertions use gateway envelopes only. */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { describe, expect, it } from 'vitest';
import { resolveHermesExecutable } from './detection.js';
import { createHermesTuiSession } from './driver.js';
import { resolveHermesPython } from './launch/gateway-host.js';
import { waitFor } from './test-support/live-harness.js';
import { isolatedHermesLiveEnvironment, startHermesLoopbackProvider } from './test-support/live-model.js';
import { HermesLivePtyHost } from './test-support/live-pty-host.js';
import { parseHermesFrame } from './normalization/types.js';

const live = process.env.HERMES_LIVE === '1';

describe.runIf(live)('Hermes interactions beside the real native TUI (live)', () => {
  for (const scenario of ['permission-deny', 'clarify-answer', 'clarify-interrupt'] as const) {
    it(
      scenario,
      async () => {
        const startedAt = new Date().toISOString();
        const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-hermes-interaction-')));
        const cwd = join(root, 'workspace');
        const home = join(root, 'home');
        const scratch = join(cwd, 'approval-scratch');
        mkdirSync(scratch, { recursive: true });
        writeFileSync(join(scratch, 'sentinel'), 'must survive denied approval');
        const tuiDirectory = process.env.HERMES_TUI_DIR;
        if (!tuiDirectory) throw new Error('HERMES_TUI_DIR is required');
        const permission = scenario === 'permission-deny';
        const provider = await startHermesLoopbackProvider(
          permission
            ? { name: 'terminal', arguments: { command: `rm -rf '${scratch}'` } }
            : { name: 'clarify', arguments: { question: 'SURFACE_HERMES_QUESTION', choices: ['Alpha', 'Beta'] } },
        );
        const host = new HermesLivePtyHost();
        let session: Awaited<ReturnType<typeof createHermesTuiSession>> | undefined;
        let projection: ReturnType<typeof projectAgentEvents> | undefined;
        try {
          session = await createHermesTuiSession({
            cwd,
            host,
            executable: resolveHermesExecutable(),
            python: resolveHermesPython(),
            hermesHome: home,
            env: isolatedHermesLiveEnvironment(root, home, tuiDirectory, provider.baseUrl),
            promptConfirmationTimeoutMs: 45_000,
          });
          projection = projectAgentEvents(session);
          // A rendered composer establishes that the native client has attached before the tool runs.
          await waitFor(
            () => host.output(session!.runtimeSessionId).includes('puppeteer-hermes-live'),
            'native TUI ready',
          );
          expect(
            await session.services.prompt.submit({
              text: `Run the requested ${permission ? 'terminal' : 'clarify'} tool once.`,
            }),
          ).toMatchObject({ status: 'confirmed' });
          const requested = permission ? 'interaction:permission-requested' : 'interaction:question-requested';
          await waitFor(() => projection!.envelopes.some(({ event }) => event.type === requested), requested);
          const request = projection.envelopes.find(({ event }) => event.type === requested)!;
          expect(request.source).toBe('native-protocol');
          expect(request.nativeEvent).toMatchObject({
            method: permission ? 'approval' : 'clarify',
            id: expect.stringMatching(/^srq-/),
          });
          if (scenario === 'clarify-interrupt') {
            expect(await session.services.turnStop!.submit()).toMatchObject({ accepted: true });
          } else {
            // The question text also appears in the tool-call summary before the answer menu mounts.
            // Wait for the menu's own input instructions so Enter cannot land on the composer.
            await waitFor(
              () =>
                host
                  .output(session!.runtimeSessionId)
                  .includes(permission ? 'approval required' : 'Enter confirm · 1-2 quick pick'),
              'native interaction overlay',
            );
            expect(
              await host.automateTerminal(session.runtimeSessionId, { kind: 'text', text: permission ? '\x1b' : '\r' }),
            ).toMatchObject({ accepted: true });
          }
          await waitFor(
            () =>
              projection!.envelopes.some(
                ({ event }) => event.type === (scenario === 'clarify-interrupt' ? 'turn:failed' : 'turn:completed'),
              ),
            'turn completion after interaction',
          );
          const resolved = permission ? 'interaction:permission-resolved' : 'interaction:question-resolved';
          await waitFor(() => projection!.envelopes.some(({ event }) => event.type === resolved), resolved, 5_000);
          const settled = projection.envelopes.filter(({ event }) => event.type === resolved);
          expect(settled).toHaveLength(1);
          if (scenario === 'clarify-interrupt') {
            expect(settled[0]?.nativeEvent).toMatchObject({ method: 'event', params: { type: 'request.cancel' } });
            expect(settled[0]?.event).toMatchObject({ outcome: 'cancelled' });
          } else if (!permission) {
            expect(settled[0]?.event).toMatchObject({ outcome: 'answered' });
            expect(settled[0]?.nativeEvent).toMatchObject({
              method: 'event',
              params: { type: 'tool.complete', payload: { result: { user_response: 'Alpha' } } },
            });
          }
          expect(existsSync(join(scratch, 'sentinel'))).toBe(true);
          const captureDirectory = process.env.HERMES_INTERACTION_CAPTURE_DIR;
          if (captureDirectory) {
            const artifact = process.env.PUPPETEER_LIVE_ARTIFACT;
            if (!artifact) throw new Error('PUPPETEER_LIVE_ARTIFACT is required when retaining interaction captures');
            // Retain only the structured frames under test, never gateway launch data, provider prompts or tokens.
            const retained = new Set(['tool.start', 'tool.complete', 'message.complete', 'request.cancel']);
            const seen = new Set<string>();
            const frames = projection.envelopes.flatMap(({ nativeEvent }) => {
              const parsed = parseHermesFrame(nativeEvent);
              if (!parsed.serverRequest && !retained.has(parsed.type ?? '')) return [];
              const json = JSON.stringify(nativeEvent);
              if (seen.has(json)) return [];
              seen.add(json);
              return [JSON.parse(json.split(root).join('<redacted:root>'))];
            });
            mkdirSync(captureDirectory, { recursive: true });
            writeFileSync(
              join(captureDirectory, `${scenario}.json`),
              `${JSON.stringify(
                {
                  schemaVersion: 1,
                  scenario,
                  startedAt,
                  completedAt: new Date().toISOString(),
                  platform: `${process.platform}-${process.arch}`,
                  nodeVersion: process.versions.node,
                  artifactSha256: `sha256:${createHash('sha256').update(readFileSync(artifact)).digest('hex')}`,
                  scope: 'selected native gateway frames observed beside an attached TUI; not a promotion receipt',
                  frames,
                },
                null,
                2,
              )}\n`,
            );
          }
        } catch (cause) {
          throw new Error(
            `${scenario}: events=${JSON.stringify(projection?.envelopes.map(({ event }) => event.type))} tui=${JSON.stringify(session ? host.output(session.runtimeSessionId).slice(-5_000) : '')}`,
            { cause },
          );
        } finally {
          projection?.dispose();
          if (session) await host.disposeTerminal(session.runtimeSessionId);
          await session?.dispose();
          await host.dispose();
          await provider.close();
          try {
            rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
          } catch (error) {
            console.error('HERMES CLEANUP FILES', readdirSync(root, { recursive: true }));
            try {
              console.error(execFileSync('lsof', ['+D', root], { encoding: 'utf8' }));
            } catch (diagnostic) {
              console.error((diagnostic as { stdout?: string }).stdout);
            }
            throw error;
          }
        }
      },
      120_000,
    );
  }
});
