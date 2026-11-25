/**
 * Opt-in proof that a briefed run's MCP servers reach the session the native TUI joins. A live Grok Build 1.0.92
 * session started with a briefed server listed only the person's own servers (2026-11-24), so the adapter's reading
 * that the leader keeps `session/new`'s servers for the session was not what Grok does. The run here is the real TUI in
 * a PTY, its own leader and ACP control, against a loopback model with an isolated HOME and GROK_HOME, as in
 * acp.live.test.ts; the probe server records its own start, parent and requests.
 *
 *   GROK_LIVE=1 PUPPETEER_GROK_BIN=/absolute/path/to/grok pnpm test briefing.live
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentHelperProcess } from '@vibefield/puppeteer-core';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { describe, expect, it } from 'vitest';
import { resolveGrokExecutable } from './detection.js';
import { createGrokBackend } from './driver.js';
import {
  GROK_LIVE_MODEL,
  GROK_LIVE_RESPONSE_MARKER,
  isolatedGrokLiveEnvironment,
  startGrokLoopbackProvider,
  writeGrokLiveConfiguration,
} from './test-support/live-model.js';
import { GrokLivePtyHost, delay, waitFor } from './test-support/live-pty-host.js';
import { GROK_PROBE_TOOL, writeProbeMcpServer, type ProbeLogEntry } from './test-support/probe-mcp-server.js';

const live = process.env.GROK_LIVE === '1';

function readProbeLog(path: string): ProbeLogEntry[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as ProbeLogEntry);
  } catch {
    return [];
  }
}

/** The probe processes still running: started, with no end after their start. */
function liveProbes(entries: readonly ProbeLogEntry[]): number[] {
  const running = new Set<number>();
  for (const entry of entries) {
    if (entry.event === 'start') running.add(entry.pid);
    if (entry.event === 'end') running.delete(entry.pid);
  }
  return [...running];
}

describe.runIf(live)('Grok briefed servers through the real native TUI (live)', () => {
  it('connects a briefed server to the session the TUI joins, under the run leader, for the whole session', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-grok-briefing-')));
    const grokHome = join(root, 'grok-home');
    const cwd = join(root, 'workspace');
    for (const directory of [grokHome, cwd, join(root, 'tmp')]) mkdirSync(directory, { recursive: true });
    const serverPath = join(root, 'probe-server.mjs');
    const logPath = join(root, 'probe.log');
    writeProbeMcpServer(serverPath);
    const provider = await startGrokLoopbackProvider();
    writeGrokLiveConfiguration(grokHome, provider.baseUrl);
    const environment = isolatedGrokLiveEnvironment(root, grokHome, provider.baseUrl);
    const executable = resolveGrokExecutable();
    const host = new GrokLivePtyHost();
    const backend = createGrokBackend({ executable, host, appServerEnv: environment });
    const helpers: AgentHelperProcess[] = [];
    let session: Awaited<ReturnType<typeof backend.createSession>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    try {
      session = await backend.createSession({
        cwd,
        model: GROK_LIVE_MODEL,
        permissionMode: 'default',
        mcpServers: { probe: { command: process.execPath, args: [serverPath, logPath] } },
        ingress: { onHelperProcess: (helper) => void helpers.push(helper) },
        onApproval: () => 'approved',
      });
      projection = projectAgentEvents(session);
      expect(helpers).toHaveLength(1);
      // The TUI joins by --resume as the terminal starts; let its load settle before the turn.
      await delay(5_000);
      const receipt = await session.services.prompt.submit({
        text: `Reply with exactly ${GROK_LIVE_RESPONSE_MARKER} and do not use tools.`,
      });
      expect(receipt, host.output(session.runtimeSessionId)).toMatchObject({ status: 'confirmed' });
      await waitFor(
        () => projection!.envelopes.some(({ event }) => event.type === 'turn:completed'),
        'the turn to complete',
      );
      const entries = readProbeLog(logPath);
      const turnBodies = provider.requests
        .filter(({ url }) => url?.startsWith('/v1/chat/completions'))
        .map(({ body }) => JSON.stringify(body));
      const evidence = {
        helpers,
        probe: entries,
        modelRequestsNamingTheProbe: turnBodies.filter((body) => body.includes(GROK_PROBE_TOOL)).length,
        modelRequests: turnBodies.length,
        tui: host.output(session.runtimeSessionId).slice(-4_000),
      };
      if (process.env.GROK_LIVE_EVIDENCE)
        writeFileSync(process.env.GROK_LIVE_EVIDENCE, JSON.stringify(evidence, null, 2), 'utf8');
      const detail = JSON.stringify({ ...evidence, tui: undefined });

      // Started and listed: Grok connected the server.
      expect(
        entries.some((entry) => entry.event === 'request' && entry.method === 'tools/list'),
        detail,
      ).toBe(true);
      // Still running after the TUI joined and a turn ran: the session the person types in holds it.
      const running = liveProbes(entries);
      expect(running.length, detail).toBeGreaterThan(0);
      // Never this process's own child: a Grok process started it, so the door walks it to the run's helper root (the
      // leader) or to the pane. The evidence keeps each start's parent beside the leader's pid.
      const starts = entries.filter((entry) => entry.event === 'start' && running.includes(entry.pid));
      expect(
        starts.every((entry) => entry.ppid !== process.pid),
        detail,
      ).toBe(true);
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
