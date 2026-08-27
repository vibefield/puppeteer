/**
 * Grok native-TUI driver composition: shared leader lifecycle plus per-session
 * launch, observer, and ACP-control services.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentAdapterBinding, TerminalSpec } from '@vibecook/puppeteer-core';
import { grokUpdatesPath, latestGrokSessionId } from './observation/session-discovery.js';
import { createGrokSessionObserver } from './observation/session-observer.js';
import { openGrokControl } from './services/acp-control.js';
import { createPreparedGrokSession } from './services/prepared-session.js';
import { buildGrokTuiArgs } from './launch/tui.js';
import type { CreateGrokBackendOptions, CreateGrokSessionOptions, GrokBackend, PreparedGrokSession } from './types.js';

export type { CreateGrokBackendOptions, CreateGrokSessionOptions, GrokBackend, PreparedGrokSession } from './types.js';
export { createPendingControlSession } from './services/control-session.js';
export { createPreparedGrokSession } from './services/prepared-session.js';
export { buildGrokTuiArgs } from './launch/tui.js';

export function createGrokBackend(options: CreateGrokBackendOptions): GrokBackend {
  const executable = options.executable ?? 'grok';
  const host = options.host;
  let ownedImposterHome: string | undefined;
  const childExtras = options.appServerEnv ? { ...options.appServerEnv } : undefined;
  // All three Grok processes and the parent-side observer must share one home.
  // The native-invocation service supplies a host-owned durable root. A direct
  // adapter caller that selects the persona without one gets an adapter-owned
  // ephemeral root, cleaned with the backend. Real Grok launches retain normal
  // GROK_HOME rules.
  if (childExtras?.AI_PERSONA === 'grok') {
    if (
      childExtras.PUPPETEER_IMPOSTER_HOME &&
      childExtras.GROK_HOME &&
      resolve(childExtras.PUPPETEER_IMPOSTER_HOME) !== resolve(childExtras.GROK_HOME)
    ) {
      throw new Error('Grok Imposter requires PUPPETEER_IMPOSTER_HOME and GROK_HOME to name the same root');
    }
    const configured = childExtras.PUPPETEER_IMPOSTER_HOME ?? childExtras.GROK_HOME;
    const imposterHome = configured ?? mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-grok-imposter-home-'));
    if (!configured) ownedImposterHome = imposterHome;
    childExtras.PUPPETEER_IMPOSTER_HOME = imposterHome;
    childExtras.GROK_HOME = imposterHome;
  }
  const childEnv: NodeJS.ProcessEnv | undefined = childExtras ? { ...process.env, ...childExtras } : undefined;
  const grokHome = childExtras?.GROK_HOME ?? process.env.GROK_HOME;
  type Leader = { socketPath: string; directory: string; child: ChildProcess };
  let leader: Leader | undefined;
  let startingLeader: Leader | undefined;
  let leaderPromise: Promise<Leader> | undefined;
  let disposed = false;

  const live = (candidate: Leader | undefined): candidate is Leader =>
    candidate !== undefined && candidate.child.exitCode === null && !candidate.child.killed;

  const stopLeader = (candidate: Leader | undefined): void => {
    if (!candidate) return;
    try {
      candidate.child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    rmSync(candidate.directory, { recursive: true, force: true });
    if (leader === candidate) leader = undefined;
    if (startingLeader === candidate) startingLeader = undefined;
  };

  async function startLeader(): Promise<Leader> {
    if (disposed) throw new Error('Grok backend is disposed');
    if (leader) stopLeader(leader);

    // macOS /tmp is a symlink the agent's socket bind rejects — use the real tmp.
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-grok-'));
    const socketPath = join(dir, 'leader.sock');
    const child = spawn(
      executable,
      ['agent', 'leader', '--no-exit-on-disconnect', '--relay-on-demand', '--leader-socket', socketPath],
      { stdio: 'ignore', env: childEnv },
    );
    const candidate = { socketPath, directory: dir, child };
    startingLeader = candidate;
    let spawnError: Error | undefined;
    child.once('error', (error) => {
      spawnError = error;
    });
    try {
      for (let i = 0; i < 80 && !existsSync(socketPath); i++) {
        if (disposed || spawnError || child.exitCode !== null || child.signalCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (disposed) throw new Error('Grok backend was disposed while its leader was starting');
      if (!existsSync(socketPath)) {
        const detail = spawnError
          ? `: ${spawnError.message}`
          : child.exitCode === null
            ? ''
            : `, exit ${child.exitCode}`;
        throw new Error(`grok agent leader failed to start (no socket${detail})`);
      }
      leader = candidate;
      startingLeader = undefined;
      return candidate;
    } catch (error) {
      stopLeader(candidate);
      throw error;
    }
  }

  async function ensureLeader(): Promise<string> {
    if (disposed) throw new Error('Grok backend is disposed');
    if (live(leader)) return leader.socketPath;
    if (leader) stopLeader(leader);
    const pending = leaderPromise ?? startLeader();
    leaderPromise = pending;
    try {
      return (await pending).socketPath;
    } finally {
      if (leaderPromise === pending) leaderPromise = undefined;
    }
  }

  async function prepareSession(opts: CreateGrokSessionOptions): Promise<PreparedGrokSession> {
    const { cwd } = opts;
    const socketPath = await ensureLeader();
    // Materialize the leader-owned session before returning the launch recipe.
    // A fresh TUI does not persist its --session-id until the first prompt, so
    // racing session/load against process startup can leave control unattached
    // forever. ACP session/new gives us the authoritative id up front; the TUI
    // then joins that already-real session through --resume.
    const resume = opts.resume ?? (opts.resumeLatest ? await latestGrokSessionId(cwd, grokHome) : undefined);
    if (opts.resumeLatest && !resume) throw new Error(`no Grok session is available to resume in ${cwd}`);
    const control = await openGrokControl(executable, cwd, socketPath, resume, opts, childEnv);
    const sessionId = control.sessionId;
    const launch: TerminalSpec = {
      command: executable,
      args: buildGrokTuiArgs(socketPath, sessionId, { ...opts, resume: sessionId }),
      cwd,
      ...(childExtras ? { env: childExtras } : {}),
    };
    return createPreparedGrokSession(
      sessionId,
      launch,
      () => control,
      () => control.dispose(),
      () => createGrokSessionObserver(grokUpdatesPath(cwd, sessionId, grokHome)),
      {
        cwd,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
        ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
      },
    );
  }

  return {
    prepareSession,

    async createSession(opts): Promise<AgentAdapterBinding> {
      const prepared = await prepareSession(opts);
      try {
        const { runtimeSessionId } = await host.spawnTerminal(prepared.launch);
        return await prepared.adopt(runtimeSessionId);
      } catch (err) {
        await prepared.dispose();
        throw err;
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopLeader(startingLeader);
      stopLeader(leader);
      if (ownedImposterHome) {
        rmSync(ownedImposterHome, { recursive: true, force: true });
        ownedImposterHome = undefined;
      }
    },
  };
}
