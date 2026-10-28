/**
 * Grok native-TUI driver composition: shared leader lifecycle plus per-session
 * launch, observer, and ACP-control services.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentAdapterBinding, TerminalSpec } from '@vibefield/puppeteer-core';
import { resolveGrokExecutable } from './detection.js';
import { grokHomeIn, grokUpdatesPath, latestGrokSessionId } from './observation/session-discovery.js';
import { createGrokSessionObserver } from './observation/session-observer.js';
import { openGrokControl } from './services/acp-control.js';
import { createGrokLeaderService } from './services/leader.js';
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
  // The leader runs the agent's turns and tools: under a host that composes a helper environment
  // it and its ACP controller get the agent's, never this process's own. The observer reads the
  // home they run under.
  const childEnv: NodeJS.ProcessEnv | undefined =
    host.helperEnvironment?.(childExtras ?? {}) ?? (childExtras ? { ...process.env, ...childExtras } : undefined);
  const grokHome = grokHomeIn(childEnv ?? process.env);
  const leader = createGrokLeaderService({ executable, env: childEnv });
  let disposed = false;
  let disposal: Promise<void> | undefined;

  async function prepareSession(opts: CreateGrokSessionOptions): Promise<PreparedGrokSession> {
    if (disposed) throw new Error('Grok backend is disposed');
    const { cwd } = opts;
    const socketPath = await leader.ensure();
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
    const control = await openGrokControl(executable, cwd, socketPath, resume, opts, childEnv, { viewer: 'attached' });
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

    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true;
      // The leader may still be writing into an adapter-owned Imposter home
      // while it drains, so that home goes only after the leader has exited.
      disposal = leader.dispose().then(() => {
        const home = ownedImposterHome;
        ownedImposterHome = undefined;
        if (!home) return;
        try {
          rmSync(home, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup of an ephemeral root: disposal never rejects,
          // and builtin-providers disposes backends without awaiting them.
        }
      });
      return disposal;
    },
  };
}
