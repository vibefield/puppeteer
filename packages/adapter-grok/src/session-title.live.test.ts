/**
 * Opt-in proof that a Grok session's title reaches the session's event stream, beside the exact native TUI: the title
 * Grok writes for the session after its first prompt is heard, so is the name a person's `/rename` gives it, a resumed
 * session says the title it has, and `/rename --auto` is heard as no title. Grok keeps the title in the session's
 * `summary.json` alone. Model traffic and user state stay isolated, as in `acp.live.test.ts`, so the lane needs no
 * credentials.
 *
 *   GROK_LIVE=1 PUPPETEER_GROK_BIN=/absolute/path/to/grok pnpm test
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEventEnvelope } from '@vibefield/puppeteer-core';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { describe, expect, it } from 'vitest';
import { resolveGrokExecutable } from './detection.js';
import { createGrokBackend } from './driver.js';
import {
  classifyGrokLiveModelRequest,
  GROK_LIVE_MODEL,
  GROK_LIVE_RESPONSE_MARKER,
  GROK_LIVE_SESSION_TITLE,
  isolatedGrokLiveEnvironment,
  startGrokLoopbackProvider,
  writeGrokLiveConfiguration,
} from './test-support/live-model.js';
import { delay, GrokLivePtyHost, waitFor } from './test-support/live-pty-host.js';

const live = process.env.GROK_LIVE === '1';

/** Every word the stream said of the session's title, in order: a start's, then each update's (null: none now). */
function titles(envelopes: readonly AgentEventEnvelope[]): Array<string | null> {
  return envelopes.flatMap(({ event }) =>
    event.type === 'session:title-updated'
      ? [event.title]
      : event.type === 'session:started' && event.title !== undefined
        ? [event.title]
        : [],
  );
}

describe.runIf(live)("a Grok session's title through the real native TUI (live)", () => {
  it('is heard when Grok writes it, when a person renames the session, on resume, and when it is handed back', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-grok-title-')));
    const grokHome = join(root, 'grok-home');
    const cwd = join(root, 'workspace');
    for (const directory of [grokHome, cwd, join(root, 'tmp')]) mkdirSync(directory, { recursive: true });
    const provider = await startGrokLoopbackProvider();
    writeGrokLiveConfiguration(grokHome, provider.baseUrl);
    const environment = isolatedGrokLiveEnvironment(root, grokHome, provider.baseUrl);
    const host = new GrokLivePtyHost();
    const backend = createGrokBackend({ executable: resolveGrokExecutable(), host, appServerEnv: environment });
    let session: Awaited<ReturnType<typeof backend.createSession>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    let resumed: Awaited<ReturnType<typeof backend.createSession>> | undefined;
    let resumedProjection: ReturnType<typeof projectAgentEvents> | undefined;

    /** A slash command typed into the real TUI's composer, then sent. */
    const typeCommand = async (runtimeSessionId: string, command: string): Promise<void> => {
      await host.automateTerminal(runtimeSessionId, { kind: 'text', text: command });
      await delay(700);
      await host.automateTerminal(runtimeSessionId, { kind: 'text', text: '\r' });
    };

    try {
      session = await backend.createSession({ cwd, model: GROK_LIVE_MODEL, permissionMode: 'default' });
      projection = projectAgentEvents(session);
      const sessionId = session.sessionId;
      // A session nothing was said to has no title.
      expect(titles(projection.envelopes)).toEqual([]);

      const receipt = await session.services.prompt.submit({
        text: `Reply with exactly ${GROK_LIVE_RESPONSE_MARKER} and do not use tools.`,
      });
      expect(receipt, host.output(session.runtimeSessionId)).toEqual({
        status: 'confirmed',
        turnId: expect.any(String),
      });
      await waitFor(
        () => projection!.envelopes.some(({ event }) => event.type === 'turn:completed'),
        'normalized durable turn completion',
      );
      await waitFor(
        () => titles(projection!.envelopes).includes(GROK_LIVE_SESSION_TITLE),
        "the title Grok's model wrote for the session",
      );
      expect(
        provider.requests.filter(({ body }) => classifyGrokLiveModelRequest(body) === 'session-title').length,
      ).toBeGreaterThanOrEqual(1);

      await typeCommand(session.runtimeSessionId, '/rename invoices by hand');
      await waitFor(
        () => titles(projection!.envelopes).at(-1) === 'invoices by hand',
        "the name a person's /rename gave the session",
      );
      expect(titles(projection.envelopes)).toEqual([GROK_LIVE_SESSION_TITLE, 'invoices by hand']);

      const originalRuntimeSessionId = session.runtimeSessionId;
      projection.dispose();
      projection = undefined;
      await session.dispose();
      session = undefined;
      await host.disposeTerminal(originalRuntimeSessionId);

      // A resumed session says the title it has, once, and never as history.
      resumed = await backend.createSession({
        cwd,
        resume: sessionId,
        model: GROK_LIVE_MODEL,
        permissionMode: 'default',
      });
      resumedProjection = projectAgentEvents(resumed);
      await waitFor(
        () => titles(resumedProjection!.envelopes).includes('invoices by hand'),
        "the resumed session's own title",
      );
      expect(resumedProjection.envelopes.find(({ event }) => event.type === 'session:title-updated')?.replay).not.toBe(
        true,
      );
      await waitFor(
        () => host.output(resumed!.runtimeSessionId).includes(GROK_LIVE_RESPONSE_MARKER),
        'resumed history in the real native TUI',
      );

      await typeCommand(resumed.runtimeSessionId, '/rename --auto');
      await waitFor(
        () => titles(resumedProjection!.envelopes).at(-1) === null,
        'no title after the name was handed back',
      );
      expect(titles(resumedProjection.envelopes)).toEqual(['invoices by hand', null]);
    } finally {
      resumedProjection?.dispose();
      await resumed?.dispose();
      projection?.dispose();
      await session?.dispose();
      await host.dispose();
      // The leader drains for ~2 s after SIGTERM; wait for it before removing the GROK_HOME it is still writing.
      await backend.dispose();
      await provider.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 120_000);
});
