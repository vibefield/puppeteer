/**
 * Opt-in proof that a briefed run's MCP servers reach the session the native TUI joins, and stay. A live Grok Build
 * 1.0.92 session started with a briefed server listed only the person's own servers (2026-11-24): the viewer joins by
 * `--resume`, its `session/load` names the servers it discovers itself, and the leader replaces the session's client
 * servers with them, so the controller's ended. The run here is the real TUI in a PTY, its own leader and ACP control,
 * against a loopback model with an isolated HOME and GROK_HOME, as in acp.live.test.ts. A probe server records its
 * own start, parent, environment and requests. More probes stand for the person's own servers, one in each place Grok
 * discovers servers that the isolated home can hold: the user config.toml, ~/.claude.json, ~/.cursor/mcp.json, the
 * project's .mcp.json, and an enabled plugin's .mcp.json (a Grok plugin and a .claude/plugins one). A person's server
 * the TUI discovered must not be ended by the putting back of the run's servers.
 *
 *   GROK_LIVE=1 PUPPETEER_GROK_BIN=/absolute/path/to/grok pnpm test briefing.live
 */

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
/** A value the probe server must see in its own environment, though no file holds it. */
const PROBE_ENV = 'puppeteer-probe-environment-value';

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

/** The isolated home's own logs, each file's tail, for the evidence file. */
function isolatedGrokLogs(grokHome: string): Record<string, string> {
  const logs: Record<string, string> = {};
  const root = join(grokHome, 'logs');
  let names: string[] = [];
  try {
    names = readdirSync(root, { recursive: true, encoding: 'utf8' });
  } catch {
    return logs;
  }
  for (const name of names) {
    const file = join(root, name);
    try {
      if (!statSync(file).isFile()) continue;
      // The lines about plugins and MCP servers: a debug log is far longer than the evidence needs.
      logs[name] = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => /plugin|mcp|_meta/iu.test(line))
        .join('\n')
        .slice(-200_000);
    } catch {
      // A log rotated away as it was read.
    }
  }
  return logs;
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

/** One probe of the person's own in each discovery source the isolated home can hold. */
function personSources(
  root: string,
  grokHome: string,
  cwd: string,
  serverPath: string,
): Array<{ name: string; log: string }> {
  const sources: Array<{ name: string; log: string }> = [];
  const declare = (name: string) => {
    const log = join(root, `${name}.log`);
    sources.push({ name, log });
    return { command: process.execPath, args: [serverPath, log] };
  };
  const mcpJson = (name: string) => JSON.stringify({ mcpServers: { [name]: declare(name) } });
  const user = declare('userprobe');
  appendFileSync(
    join(grokHome, 'config.toml'),
    `\n[mcp_servers.userprobe]\ncommand = ${JSON.stringify(user.command)}\n` +
      `args = [${user.args.map((arg) => JSON.stringify(arg)).join(', ')}]\n` +
      `\n[plugins]\nenabled = ["grokplugin", "claudeplugin"]\n`,
  );
  writeFileSync(join(root, '.claude.json'), mcpJson('claudeprobe'), 'utf8');
  mkdirSync(join(root, '.cursor'), { recursive: true });
  writeFileSync(join(root, '.cursor', 'mcp.json'), mcpJson('cursorprobe'), 'utf8');
  writeFileSync(join(cwd, '.mcp.json'), mcpJson('projectprobe'), 'utf8');
  for (const [folder, name] of [
    [join(grokHome, 'plugins', 'grokplugin'), 'grokpluginprobe'],
    [join(root, '.claude', 'plugins', 'claudeplugin'), 'claudepluginprobe'],
  ] as const) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, '.mcp.json'), mcpJson(name), 'utf8');
  }
  return sources;
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
    const own = personSources(root, grokHome, cwd, serverPath);
    const environment = {
      ...isolatedGrokLiveEnvironment(root, grokHome, provider.baseUrl),
      // A diagnosis aid for the evidence file: Grok's own debug log of the isolated home.
      ...(process.env.GROK_LIVE_RUST_LOG
        ? { RUST_LOG: process.env.GROK_LIVE_RUST_LOG, GROK_LOG_FILE: join(grokHome, 'logs', 'debug.log') }
        : {}),
    };
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
        mcpServers: {
          probe: { command: process.execPath, args: [serverPath, logPath], env: { GROK_PROBE_ENV: PROBE_ENV } },
        },
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
      const ownEntries = Object.fromEntries(own.map(({ name, log }) => [name, readProbeLog(log)]));
      const turnBodies = provider.requests
        .filter(({ url }) => url?.startsWith('/v1/chat/completions'))
        .map(({ body }) => JSON.stringify(body));
      const evidence = {
        helpers,
        probe: entries,
        own: ownEntries,
        // What the controller heard of the session's modes, for the reader: a re-assert sends no `_meta`.
        modeEvents: projection.envelopes.filter(({ event }) => event.type === 'mode:updated').map(({ event }) => event),
        modelRequestsNamingTheProbe: turnBodies.filter((body) => body.includes(GROK_PROBE_TOOL)).length,
        modelRequests: turnBodies.length,
        tui: host.output(session.runtimeSessionId).slice(-4_000),
      };
      if (process.env.GROK_LIVE_EVIDENCE)
        writeFileSync(
          process.env.GROK_LIVE_EVIDENCE,
          JSON.stringify({ ...evidence, grokLogs: isolatedGrokLogs(grokHome) }, null, 2),
          'utf8',
        );
      const detail = JSON.stringify({ ...evidence, tui: undefined });

      // Started and listed: Grok connected the server.
      expect(
        entries.some((entry) => entry.event === 'request' && entry.method === 'tools/list'),
        detail,
      ).toBe(true);
      // Still running after the TUI joined and a turn ran: the session the person types in holds it.
      const running = liveProbes(entries);
      expect(running.length, detail).toBeGreaterThan(0);
      // The run's own leader started it, the process the host names to its door as the run's helper root.
      const starts = entries.filter((entry) => entry.event === 'start' && running.includes(entry.pid));
      expect(
        starts.every((entry) => entry.ppid === helpers[0]!.pid),
        detail,
      ).toBe(true);
      // Its environment arrived.
      expect(
        starts.every((entry) => entry.probeEnv === PROBE_ENV),
        detail,
      ).toBe(true);
      // The person's own servers: each one Grok started, started once and still running. The user config's and
      // ~/.claude.json's are known to start in this rig; a source none of whose servers started is in the evidence.
      for (const name of ['userprobe', 'claudeprobe']) {
        expect(
          ownEntries[name]!.some((entry) => entry.event === 'start'),
          `${name} ${detail}`,
        ).toBe(true);
      }
      for (const [name, sourceEntries] of Object.entries(ownEntries)) {
        if (!sourceEntries.some((entry) => entry.event === 'start')) continue;
        expect(
          sourceEntries.filter((entry) => entry.event === 'start'),
          `${name} ${detail}`,
        ).toHaveLength(1);
        expect(liveProbes(sourceEntries), `${name} ${detail}`).toHaveLength(1);
      }
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
