/**
 * Opt-in proof that a managed Grok session without a host approval handler
 * defers leader-routed permission requests to the person in Grok's own TUI.
 * The keystrokes below are control input only: every assertion reads native
 * evidence (the normalized ACP permission events, the workspace file the
 * command writes, and Grok's persisted-rule files), never terminal text.
 *
 *   GROK_LIVE=1 PUPPETEER_GROK_BIN=/absolute/path/to/grok pnpm test
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentEventEnvelope } from '@vibefield/puppeteer-core';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { describe, expect, it } from 'vitest';
import { detectGrokInstallation, resolveGrokExecutable } from './detection.js';
import { createGrokBackend } from './driver.js';
import {
  GROK_LIVE_MODEL,
  GROK_LIVE_RESPONSE_MARKER,
  GROK_LIVE_TOOL_FILE,
  GROK_LIVE_TOOL_TRIGGER,
  isolatedGrokLiveEnvironment,
  startGrokLoopbackProvider,
  writeGrokLiveConfiguration,
} from './test-support/live-model.js';
import { delay, GrokLivePtyHost, waitFor } from './test-support/live-pty-host.js';

const live = process.env.GROK_LIVE === '1';

function persistedPermissionRules(grokHome: string): string[] {
  try {
    return readdirSync(join(grokHome, 'sessions'), { recursive: true, encoding: 'utf8' })
      .map((entry) => basename(entry))
      .filter((name) => name.startsWith('permission__'));
  } catch {
    return [];
  }
}

const ofType = (envelopes: readonly AgentEventEnvelope[], type: string) =>
  envelopes.filter(({ event }) => event.type === type);

describe.runIf(live)('Grok approvals answered in the native TUI (live)', () => {
  it('leaves the request to the person and normalizes the outcome Grok reports', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-grok-approval-live-')));
    const grokHome = join(root, 'grok-home');
    const cwd = join(root, 'workspace');
    for (const directory of [grokHome, cwd, join(root, 'tmp')]) mkdirSync(directory, { recursive: true });
    const provider = await startGrokLoopbackProvider();
    writeGrokLiveConfiguration(grokHome, provider.baseUrl);
    const environment = isolatedGrokLiveEnvironment(root, grokHome, provider.baseUrl);
    const executable = resolveGrokExecutable();
    const host = new GrokLivePtyHost();
    const backend = createGrokBackend({ executable, host, appServerEnv: environment });
    let session: Awaited<ReturnType<typeof backend.createSession>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    try {
      expect((await detectGrokInstallation(executable, { env: environment })).exactTarget).toBe(true);
      // No onApproval: the person answers in Grok's TUI.
      session = await backend.createSession({ cwd, model: GROK_LIVE_MODEL, permissionMode: 'default' });
      projection = projectAgentEvents(session);
      const terminal = session.runtimeSessionId;
      const toolFile = join(cwd, GROK_LIVE_TOOL_FILE);
      const resolutions = () =>
        ofType(projection!.envelopes, 'interaction:permission-resolved').map(({ event }) =>
          event.type === 'interaction:permission-resolved' ? event.outcome : undefined,
        );
      const turnsEnded = () =>
        ofType(projection!.envelopes, 'turn:completed').length + ofType(projection!.envelopes, 'turn:failed').length;

      /** One deferred request, answered with `key` in the TUI. */
      async function answerInTui(key: string, label: string): Promise<void> {
        const requestedBefore = ofType(projection!.envelopes, 'interaction:permission-requested').length;
        const resolvedBefore = resolutions().length;
        const endedBefore = turnsEnded();
        const receipt = await session!.services.prompt.submit({
          text: `${GROK_LIVE_TOOL_TRIGGER}: run the command, then reply with exactly ${GROK_LIVE_RESPONSE_MARKER}.`,
        });
        expect(receipt, host.output(terminal)).toEqual({ status: 'confirmed', turnId: expect.any(String) });
        await waitFor(
          () => ofType(projection!.envelopes, 'interaction:permission-requested').length > requestedBefore,
          `${label}: permission request`,
        );
        const requested = ofType(projection!.envelopes, 'interaction:permission-requested').at(-1)!.event;
        expect(requested).toMatchObject({ presentation: 'native-tui' });
        // Deferring means nothing answered for the person in the meantime.
        await delay(1_500);
        expect(resolutions(), `${label}: answered before the person`).toHaveLength(resolvedBefore);
        await host.automateTerminal(terminal, { kind: 'text', text: key });
        await waitFor(() => resolutions().length > resolvedBefore, `${label}: native resolution`, 20_000);
        await waitFor(() => turnsEnded() > endedBefore, `${label}: turn end`);
      }

      await answerInTui('2', 'allow once');
      expect(resolutions()).toEqual(['allowed']);
      expect(readFileSync(toolFile, 'utf8').trim()).toBe(`${GROK_LIVE_TOOL_TRIGGER}_OK`);
      // A once-answer persists no standing native rule.
      expect(persistedPermissionRules(grokHome)).toEqual([]);

      rmSync(toolFile, { force: true });
      await answerInTui('3', 'reject once');
      expect(resolutions()).toEqual(['allowed', 'denied']);
      expect(existsSync(toolFile)).toBe(false);
      expect(persistedPermissionRules(grokHome)).toEqual([]);

      // Each request resolved exactly once, and the controller's late release
      // left the session usable for an ordinary turn.
      const endedBefore = turnsEnded();
      await session.services.prompt.submit({ text: `Reply with exactly ${GROK_LIVE_RESPONSE_MARKER}.` });
      await waitFor(() => turnsEnded() > endedBefore, 'turn after the deferred approvals');
      expect(resolutions()).toEqual(['allowed', 'denied']);
    } finally {
      projection?.dispose();
      await session?.dispose();
      await host.dispose();
      await backend.dispose();
      await provider.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 120_000);
});
