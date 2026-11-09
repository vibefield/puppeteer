/**
 * Grok native-TUI driver composition: the leader lifecycle (shared, or a briefed
 * run's own) plus per-session launch, observer, and ACP-control services.
 */

import { announceRunHelper, settleAgentBriefing, withAgentBriefing } from '@vibefield/puppeteer-core';
import { GROK_BRIEFING_CAPABILITIES } from './launch/briefing.js';
import { grokHelperEnvironment } from './launch/environment.js';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentAdapterBinding, TerminalSpec } from '@vibefield/puppeteer-core';
import { resolveGrokExecutable } from './detection.js';
import {
  grokHomeIn,
  grokUpdatesPath,
  latestGrokSessionId,
  measureGrokReplayBoundary,
} from './observation/session-discovery.js';
import { createGrokSessionObserver } from './observation/session-observer.js';
import { openGrokControl } from './services/acp-control.js';
import { createGrokLeaderService, type GrokLeaderService } from './services/leader.js';
import { createPreparedGrokSession } from './services/prepared-session.js';
import { buildGrokTuiArgs } from './launch/tui.js';
import type { CreateGrokBackendOptions, CreateGrokSessionOptions, GrokBackend, PreparedGrokSession } from './types.js';

export type { CreateGrokBackendOptions, CreateGrokSessionOptions, GrokBackend, PreparedGrokSession } from './types.js';
export { createPendingControlSession } from './services/control-session.js';
export { createPreparedGrokSession } from './services/prepared-session.js';
export { buildGrokTuiArgs } from './launch/tui.js';

export function createGrokBackend(options: CreateGrokBackendOptions): GrokBackend {
  const executable = resolveGrokExecutable(options.executable);
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
  // The observer reads the home the leader and its ACP controller run under.
  const childEnv = grokHelperEnvironment(host, childExtras);
  const grokHome = grokHomeIn(childEnv ?? process.env);
  const leader = createGrokLeaderService({ executable, env: childEnv });
  /** Briefed runs' own leaders while their runs stand, so the backend can stop what a run left behind. */
  const runLeaders = new Set<GrokLeaderService>();
  /** Run leaders on their way out: until one has exited it may still write the session it held. */
  const stoppingRunLeaders = new Set<Promise<void>>();
  let disposed = false;
  let disposal: Promise<void> | undefined;

  async function prepareSession(opts: CreateGrokSessionOptions): Promise<PreparedGrokSession> {
    if (disposed) throw new Error('Grok backend is disposed');
    const refusal = opts.briefingRefusal;
    let settled = settleAgentBriefing(opts, GROK_BRIEFING_CAPABILITIES, 'Grok', refusal);
    if (childExtras?.AI_PERSONA === 'grok' || childExtras?.PUPPETEER_IMPOSTER_HOME)
      settled = settleAgentBriefing(settled.briefing, undefined, 'Grok imposter', refusal, settled.withheld);
    opts = withAgentBriefing(opts, settled.briefing);
    const { cwd } = opts;
    // A shared leader cannot name a run: the door names a caller by ancestry, and every run's MCP children would share
    // one parent. A run that declares servers gets a leader of its own (`--leader-socket`), named to the host before
    // ACP's session/new can start them. That the leader spawns them directly and per session is this adapter's earlier
    // reading; it has NOT been observed against a live Grok.
    const runLeader =
      Object.keys(opts.mcpServers ?? {}).length > 0
        ? createGrokLeaderService({ executable, env: childEnv })
        : undefined;
    if (runLeader) runLeaders.add(runLeader);
    let stopping: Promise<void> | undefined;
    // Registered synchronously, as the run begins to stop: a run's exit is recorded before its leader's ~2 s drain, and
    // its control is still closing before that. `closing` goes first, so the leader drains with nobody talking to it.
    const stopRunLeader = (closing: Promise<unknown> = Promise.resolve()): Promise<void> => {
      if (!runLeader) return Promise.resolve();
      if (stopping) return stopping;
      const stopped: Promise<void> = closing
        .catch(() => undefined)
        .then(() => runLeader.dispose())
        .finally(() => {
          stoppingRunLeaders.delete(stopped);
          runLeaders.delete(runLeader);
        });
      stoppingRunLeaders.add(stopped);
      stopping = stopped;
      return stopped;
    };
    let control: AgentAdapterBinding | undefined;
    try {
      // A resume must not open a session its previous run's leader is still draining. A fresh session has no such past.
      if (opts.resume !== undefined || opts.resumeLatest) await Promise.allSettled([...stoppingRunLeaders]);
      const socketPath = await (runLeader ?? leader).ensure();
      if (runLeader) await announceRunHelper(opts.ingress, runLeader.helper() ?? { startedAtMs: Date.now() }, 'Grok');
      // Materialize the leader-owned session before returning the launch recipe.
      // A fresh TUI does not persist its --session-id until the first prompt, so
      // racing session/load against process startup can leave control unattached
      // forever. ACP session/new gives us the authoritative id up front; the TUI
      // then joins that already-real session through --resume.
      const resume = opts.resume ?? (opts.resumeLatest ? await latestGrokSessionId(cwd, grokHome) : undefined);
      if (opts.resumeLatest && !resume) throw new Error(`no Grok session is available to resume in ${cwd}`);
      // Every session this backend prepares is launched with the native viewer
      // on the same leader session (the recipe below), so the person answers
      // permission requests there unless the host supplied a handler. A viewer
      // that joins after a request was issued is still shown it (1.0.70 probe).
      const opened = await openGrokControl(executable, cwd, socketPath, resume, opts, childEnv, { viewer: 'attached' });
      control = opened;
      const sessionId = opened.sessionId;
      const updatesPath = grokUpdatesPath(cwd, sessionId, grokHome);
      // The replay boundary is drawn here, once control holds the session and before the terminal spawns and adopt
      // hands the binding back, so no prompt through this binding reaches the leader first. A session ACP's session/new
      // created (no resume id, as openGrokControl reads it) has nothing to replay. A resume's history is its log as it
      // stands now, measured in whichever cwd bucket holds the session, so a relocated resume never reads it as live.
      const replayBoundary = resume ? measureGrokReplayBoundary(updatesPath) : 0;
      const launch: TerminalSpec = {
        command: executable,
        args: buildGrokTuiArgs(socketPath, sessionId, { ...opts, resume: sessionId }),
        cwd,
        ...(childExtras ? { env: childExtras } : {}),
      };
      const session = createPreparedGrokSession(
        sessionId,
        launch,
        () => opened,
        () => opened.dispose(),
        () => createGrokSessionObserver(updatesPath, { replayBoundary }),
        {
          cwd,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
          ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
        },
        runLeader ? stopRunLeader : undefined,
      );
      return settled.withheld.length > 0 ? { ...session, briefingWithheld: settled.withheld } : session;
    } catch (error) {
      await control?.dispose().catch(() => undefined);
      await stopRunLeader();
      throw error;
    }
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

    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true;
      // The leader may still be writing into an adapter-owned Imposter home
      // while it drains, so that home goes only after the leader has exited.
      disposal = Promise.all([leader.dispose(), ...[...runLeaders].map((runLeader) => runLeader.dispose())]).then(
        () => {
          const home = ownedImposterHome;
          ownedImposterHome = undefined;
          if (!home) return;
          try {
            rmSync(home, { recursive: true, force: true });
          } catch {
            // Best-effort cleanup of an ephemeral root: disposal never rejects,
            // and builtin-providers disposes backends without awaiting them.
          }
        },
      );
      return disposal;
    },
  };
}
