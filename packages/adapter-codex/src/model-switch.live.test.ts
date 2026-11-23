/**
 * Opt-in proof that a running Codex thread's model and effort are changed through its own app-server, beside the
 * exact native TUI: the request is taken, Codex's `thread/settings/updated` reaches the session's event stream, the
 * turn the TUI starts next is served by what was asked for, the profile's configuration is not written, and a change
 * another client makes is observed too. Model traffic and user state stay isolated, as in `native-tui.live.test.ts`,
 * so the lane needs no credentials.
 *
 *   CODEX_NATIVE_TUI_LIVE=1 PUPPETEER_CODEX_BIN=/absolute/path/to/codex pnpm test
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEventEnvelope } from '@vibefield/puppeteer-core';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { describe, expect, it } from 'vitest';
import { createCodexTuiSession } from './launch/tui-session.js';
import { AppServerClient } from './transport/app-server-client.js';
import { connectAppServerEndpoint, type AppServerEndpoint } from './transport/ws-transport.js';
import { CODEX_LIVE_MODEL, CODEX_LIVE_RESPONSE_MARKER } from './test-support/live-model.js';
import { createCodexLiveProfile, requireCodexLiveExecutable } from './test-support/live-profile.js';
import { CodexLivePtyHost, waitFor } from './test-support/live-pty-host.js';

const live = process.env.CODEX_NATIVE_TUI_LIVE === '1';

/** A model the loopback provider serves like any other: Codex does not check the word against a catalog. */
const OTHER_MODEL = 'puppeteer-codex-live-other';

function modelUpdates(envelopes: readonly AgentEventEnvelope[]): string[] {
  return envelopes.flatMap(({ event }) => (event.type === 'model:updated' && event.model ? [event.model.id] : []));
}

/** Whether the monitor evidence carries `fragment`, as `normalization/monitor.ts` writes an observed metric. */
function monitorObserved(envelopes: readonly AgentEventEnvelope[], fragment: string): boolean {
  return envelopes.some(
    ({ event }) => event.type === 'monitor:batch' && JSON.stringify(event.batch).includes(fragment),
  );
}

/**
 * What the profile's configuration says of the model and its effort. The TUI writes the file for reasons of its own
 * (0.171.0 records `[tui] screen_reader_detection_done`), so only these lines are held.
 */
function configuredModel(codexHome: string): string[] {
  return readFileSync(join(codexHome, 'config.toml'), 'utf8')
    .split('\n')
    .filter((line) => /^\s*model(?:_reasoning_effort)?\s*=/u.test(line));
}

/** The private app-server's endpoint, from the address the recipe handed its TUI. */
function endpointOf(args: readonly string[]): AppServerEndpoint {
  const address = args[args.indexOf('--remote') + 1] ?? '';
  return address.startsWith('unix://')
    ? { kind: 'unix', path: address.slice('unix://'.length) }
    : { kind: 'websocket', url: address };
}

describe.runIf(live)('Codex model switch through the real app-server and native TUI (live)', () => {
  it('changes the thread, is observed, serves the next turn, and writes no configuration', async () => {
    const executable = requireCodexLiveExecutable('CODEX_NATIVE_TUI_LIVE');
    const profile = await createCodexLiveProfile('puppeteer-codex-switch-');
    const host = new CodexLivePtyHost();
    let session: Awaited<ReturnType<typeof createCodexTuiSession>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    let other: AppServerClient | undefined;
    try {
      const configured = configuredModel(profile.codexHome);
      expect(configured).toEqual([`model = "${CODEX_LIVE_MODEL}"`]);
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
      const modelSwitch = session.services.modelSwitch;
      expect(modelSwitch?.offer).toEqual({ model: true, controls: ['effort'], persistence: 'session' });

      // Asked at once, while the TUI is still joining the thread.
      await expect(modelSwitch!.submit({ kind: 'model', modelId: OTHER_MODEL })).resolves.toEqual({ status: 'sent' });
      await waitFor(() => modelUpdates(envelopes).includes(OTHER_MODEL), "Codex's own word that the model changed");
      await waitFor(
        () => monitorObserved(envelopes, `"providerModelId":${JSON.stringify(OTHER_MODEL)}`),
        'the changed model in the monitor evidence',
      );

      await expect(modelSwitch!.submit({ kind: 'control', controlId: 'effort', value: 'high' })).resolves.toEqual({
        status: 'sent',
      });
      await waitFor(
        () => monitorObserved(envelopes, '"kind":"effort","value":"high","intent":"observed"'),
        "Codex's own word that the effort changed",
      );
      expect(configuredModel(profile.codexHome)).toEqual(configured);

      // The turn is the TUI's own: it is served by what the thread was changed to.
      const receipt = await session.services.prompt.submit({
        text: `Reply with exactly ${CODEX_LIVE_RESPONSE_MARKER} and do not use tools.`,
      });
      expect(receipt, host.output(session.runtimeSessionId)).toMatchObject({ status: 'confirmed' });
      await waitFor(() => envelopes.some(({ event }) => event.type === 'turn:completed'), 'the turn', 60_000);
      const turns = profile.provider!.requests.filter(({ kind }) => kind === 'turn');
      expect(turns).toHaveLength(1);
      expect(turns[0]!.body).toMatchObject({ model: OTHER_MODEL, reasoning: { effort: 'high' } });
      expect(configuredModel(profile.codexHome)).toEqual(configured);

      // A change made by another client of the same app-server, as the TUI's own picker is, is observed too.
      const before = modelUpdates(envelopes).length;
      other = new AppServerClient(connectAppServerEndpoint(endpointOf(host.launches[0]!.args)));
      await other.request('initialize', {
        clientInfo: { name: 'puppeteer-live-other', version: '0' },
        capabilities: { experimentalApi: true },
      });
      other.notify('initialized');
      await other.request('thread/settings/update', { threadId: session.sessionId, model: CODEX_LIVE_MODEL });
      await waitFor(
        () => modelUpdates(envelopes).slice(before).includes(CODEX_LIVE_MODEL),
        'a change made outside the service',
      );
    } finally {
      await other?.close();
      projection?.dispose();
      await session?.dispose();
      await host.dispose();
      await profile.dispose();
    }
  }, 120_000);
});
