/**
 * Opt-in proof that a Codex thread's name reaches the session's event stream as its title, beside the exact native
 * TUI: the name Codex writes for the thread after its first turn is heard, and so is a name another client of the
 * same app-server sets, as the TUI's own `/rename` is one; and a resume of the thread starts with the name it has.
 * Model traffic and user state stay isolated, as in
 * `native-tui.live.test.ts`, so the lane needs no credentials.
 *
 *   CODEX_NATIVE_TUI_LIVE=1 PUPPETEER_CODEX_BIN=/absolute/path/to/codex pnpm test
 */

import type { AgentEventEnvelope } from '@vibefield/puppeteer-core';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { describe, expect, it } from 'vitest';
import { createCodexTuiSession } from './launch/tui-session.js';
import { AppServerClient } from './transport/app-server-client.js';
import { connectAppServerEndpoint, type AppServerEndpoint } from './transport/ws-transport.js';
import { CODEX_LIVE_MODEL, CODEX_LIVE_RESPONSE_MARKER, CODEX_LIVE_THREAD_TITLE } from './test-support/live-model.js';
import { createCodexLiveProfile, requireCodexLiveExecutable } from './test-support/live-profile.js';
import { CodexLivePtyHost, waitFor } from './test-support/live-pty-host.js';

const live = process.env.CODEX_NATIVE_TUI_LIVE === '1';

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

/** The private app-server's endpoint, from the address the recipe handed its TUI. */
function endpointOf(args: readonly string[]): AppServerEndpoint {
  const address = args[args.indexOf('--remote') + 1] ?? '';
  return address.startsWith('unix://')
    ? { kind: 'unix', path: address.slice('unix://'.length) }
    : { kind: 'websocket', url: address };
}

describe.runIf(live)("a Codex thread's name through the real app-server and native TUI (live)", () => {
  it('is heard as the title when Codex names the thread, when a client renames it, and when the thread is resumed', async () => {
    const executable = requireCodexLiveExecutable('CODEX_NATIVE_TUI_LIVE');
    const profile = await createCodexLiveProfile('puppeteer-codex-title-');
    const host = new CodexLivePtyHost();
    let session: Awaited<ReturnType<typeof createCodexTuiSession>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    let other: AppServerClient | undefined;
    let resumed: Awaited<ReturnType<typeof createCodexTuiSession>> | undefined;
    let resumedProjection: ReturnType<typeof projectAgentEvents> | undefined;
    try {
      session = await createCodexTuiSession({
        cwd: profile.cwd,
        executable,
        host,
        env: profile.environment,
        appServerEnv: profile.environment,
        model: CODEX_LIVE_MODEL,
        sandbox: 'read-only',
        approvalPolicy: 'never',
      });
      projection = projectAgentEvents(session);
      const envelopes = projection.envelopes;

      // An unnamed thread starts with no title.
      expect(titles(envelopes)).toEqual([]);
      const receipt = await session.services.prompt.submit({
        text: `Reply with exactly ${CODEX_LIVE_RESPONSE_MARKER} and do not use tools.`,
      });
      expect(receipt, host.output(session.runtimeSessionId)).toMatchObject({ status: 'confirmed' });
      await waitFor(() => envelopes.some(({ event }) => event.type === 'turn:completed'), 'the turn', 60_000);

      // Codex asks its model to name the thread after the first turn (0.171.0), and says the name to its clients.
      await waitFor(
        () => titles(envelopes).includes(CODEX_LIVE_THREAD_TITLE),
        "Codex's own word for the name it wrote",
        30_000,
      );
      expect(profile.provider!.requests.filter(({ kind }) => kind === 'thread-title')).toHaveLength(1);

      other = new AppServerClient(connectAppServerEndpoint(endpointOf(host.launches[0]!.args)));
      await other.request('initialize', {
        clientInfo: { name: 'puppeteer-live-other', version: '0' },
        capabilities: {},
      });
      other.notify('initialized');
      await other.request('thread/name/set', { threadId: session.sessionId, name: 'invoices' });
      await waitFor(() => titles(envelopes).at(-1) === 'invoices', "Codex's own word that the thread was renamed");
      expect(titles(envelopes)).toEqual([CODEX_LIVE_THREAD_TITLE, 'invoices']);

      // A resume of the thread: nothing says its name again, so the session reads it from the resume's own answer
      // and starts with its title.
      const threadId = session.sessionId;
      const firstRuntimeSessionId = session.runtimeSessionId;
      await other.close();
      other = undefined;
      projection.dispose();
      projection = undefined;
      await session.dispose();
      session = undefined;
      await host.disposeTerminal(firstRuntimeSessionId);
      resumed = await createCodexTuiSession({
        cwd: profile.cwd,
        resume: threadId,
        executable,
        host,
        env: profile.environment,
        appServerEnv: profile.environment,
      });
      resumedProjection = projectAgentEvents(resumed);
      expect(resumed.sessionId).toBe(threadId);
      await waitFor(() => titles(resumedProjection!.envelopes).length > 0, "the resumed session's title");
      expect(titles(resumedProjection.envelopes)).toEqual(['invoices']);
    } finally {
      await other?.close();
      resumedProjection?.dispose();
      await resumed?.dispose();
      projection?.dispose();
      await session?.dispose();
      await host.dispose();
      await profile.dispose();
    }
  }, 120_000);
});
