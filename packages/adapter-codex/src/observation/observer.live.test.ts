/**
 * Opt-in live test — the Model-B observe flow against real Codex. One connection
 * (a driver, standing in for the native TUI) creates + drives a thread; a
 * separate observer connection attaches via thread/started -> thread/resume and
 * must see the same turn. Skipped unless CODEX_LIVE=1. Isolated: the exact
 * codex PUPPETEER_CODEX_BIN names, a throwaway HOME and CODEX_HOME, and the
 * loopback Responses endpoint, so no account or model provider is reached
 * (codex's own curated-plugin `git` sync still goes out, findings).
 *
 *   CODEX_LIVE=1 PUPPETEER_CODEX_BIN=/absolute/path/to/codex pnpm --filter @vibefield/puppeteer-adapter-codex test
 */

import { describe, it, expect } from 'vitest';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { createCodexSession } from '../driver.js';
import { CODEX_LIVE_MODEL, CODEX_LIVE_RESPONSE_MARKER } from '../test-support/live-model.js';
import { createCodexLiveProfile, requireCodexLiveExecutable } from '../test-support/live-profile.js';
import { createCodexObserver } from './observer.js';
import { spawnAppServer } from '../transport/app-server-process.js';
import { connectAppServerEndpoint } from '../transport/ws-transport.js';

const live = process.env.CODEX_LIVE === '1';

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!live)('createCodexObserver (live, Model B)', () => {
  it('attaches to a thread another connection created and observes its turn', async () => {
    const executable = requireCodexLiveExecutable('CODEX_LIVE');
    const profile = await createCodexLiveProfile('codex-obs-');
    const server = spawnAppServer({ executable, env: profile.environment });
    let observer: Awaited<ReturnType<typeof createCodexObserver>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    let driver: Awaited<ReturnType<typeof createCodexSession>> | undefined;
    let driverProjection: ReturnType<typeof projectAgentEvents> | undefined;
    try {
      await server.ready();
      // Observer connects first and waits for a thread to appear.
      observer = await createCodexObserver({ transport: connectAppServerEndpoint(server.endpoint()) });
      projection = projectAgentEvents(observer);
      const attached = new Promise<void>((res) => observer!.onThread(() => res()));

      // Driver (stands in for the native TUI) creates + drives the thread.
      driver = await createCodexSession({
        cwd: profile.cwd,
        model: CODEX_LIVE_MODEL,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        transport: connectAppServerEndpoint(server.endpoint()),
      });
      driverProjection = projectAgentEvents(driver);
      const completedTurns = (): string[] =>
        driverProjection!.envelopes.flatMap(({ event }) =>
          event.type === 'turn:completed' && event.turnId ? [event.turnId] : [],
        );

      // Turn 1 materializes the thread (writes its rollout) so the observer's
      // retrying thread/resume can attach — a thread has no rollout before its
      // first user message.
      await driver.services.prompt.submit({ text: `Reply with exactly ${CODEX_LIVE_RESPONSE_MARKER}.` });
      await waitFor(() => completedTurns().length === 1, 60_000);
      await attached;
      expect(observer.sessionId).toBe(driver.sessionId);
      expect(observer.observationLevel()).toBe('structured');

      // Turn 2 is observed live through the attached stream. The loopback model answers every turn
      // alike, and the observer may attach while turn 1 is still streaming, so turn 2 is told apart
      // by its id, not by its answer.
      await driver.services.prompt.submit({
        text: `Reply with exactly ${CODEX_LIVE_RESPONSE_MARKER} and do not use tools.`,
      });
      await waitFor(() => completedTurns().length === 2, 60_000);
      const secondTurn = completedTurns()[1]!;
      await waitFor(
        () =>
          projection!.envelopes.some(
            ({ event, replay }) => event.type === 'turn:completed' && event.turnId === secondTurn && replay !== true,
          ),
        60_000,
      );
      expect(projection.state.lastAssistantMessage).toContain(CODEX_LIVE_RESPONSE_MARKER);
      expect(profile.provider!.requests.filter(({ kind }) => kind === 'turn')).toHaveLength(2);
    } finally {
      driverProjection?.dispose();
      projection?.dispose();
      await observer?.dispose();
      await driver?.dispose();
      await server.dispose();
      await profile.dispose();
    }
  }, 90_000);
});
