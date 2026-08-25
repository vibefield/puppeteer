/**
 * Grok's native-TUI recipe (leader + TUI + ACP control) as one adapter session.
 *
 * Grok-specific behavior contained here:
 *   1. a shared `grok agent leader`, spawned once and owned by the backend;
 *   2. a native `grok --leader` TUI spawned through the host terminal;
 *   3. a generic ACP client attached to the leader session, with Grok-specific
 *      command arguments and retry behavior while the TUI registers.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createAcpSession, createStdioAcpConnector } from '@vibecook/chopsticks-adapter-acp';
import type { CreateAcpSessionOptions } from '@vibecook/chopsticks-adapter-acp';
import {
  BufferedAgentEventSource,
  createEnvelopeStamper,
  type AgentEventEnvelope,
  type AgentHost,
  type AgentAdapterSession,
  type ObservationLevel,
  type PromptReceipt,
  type PromptSubmission,
  type TerminalSpec,
} from '@vibecook/chopsticks-core';
import type { AdapterMonitorObservationBatch } from '@vibecook/chopsticks-core/monitor-spi';
import {
  createGrokSessionObserver,
  grokExtensionEvents,
  grokUpdatesPath,
  latestGrokSessionId,
  type GrokObservedEvent,
  type GrokSessionObserver,
} from './session-observer.js';
import { GrokMonitorEvidence, type GrokConfiguredIntent } from './monitor-evidence.js';

export interface CreateGrokBackendOptions {
  /** Grok executable (default `grok`). */
  executable?: string;
  /** The host terminal capability the TUI is spawned through. */
  host: AgentHost;
  /** Extra environment shared by leader, ACP controller, TUI, and log observer. */
  appServerEnv?: Record<string, string>;
}

export interface GrokBackend {
  /** Start a Grok tab: native TUI + a control client attached to the same session. */
  createSession(opts: CreateGrokSessionOptions): Promise<AgentAdapterSession>;
  /** Prepare leader wiring and a native launch recipe without spawning the TUI. */
  prepareSession(opts: CreateGrokSessionOptions): Promise<PreparedGrokSession>;
  /** Tear down the shared leader (host shutdown). */
  dispose(): void;
}

export interface CreateGrokSessionOptions {
  cwd: string;
  resume?: string;
  /** Resolve and resume Grok's most recently updated session for this cwd. */
  resumeLatest?: boolean;
  /** Model id passed to the native Grok TUI. */
  model?: string;
  /** Grok permission mode. Kept open because the CLI's modes evolve. */
  permissionMode?: string;
  /** Grok sandbox profile passed to the native TUI. */
  sandbox?: string;
  /** ACP capabilities advertised by the structured control client. */
  clientCapabilities?: CreateAcpSessionOptions['clientCapabilities'];
  /** Decide ACP permission requests. Default: deny. */
  onApproval?: CreateAcpSessionOptions['onApproval'];
  /** Answer ACP structured elicitation requests when Grok exposes them. */
  onElicitation?: CreateAcpSessionOptions['onElicitation'];
}

export interface PreparedGrokSession {
  readonly sessionId: string;
  readonly launch: TerminalSpec;
  adopt(runtimeSessionId: string): Promise<AgentAdapterSession>;
  dispose(): Promise<void>;
}

/** Bind a prepared Grok recipe to exactly one caller-owned terminal. */
export function createPreparedGrokSession(
  sessionId: string,
  launch: TerminalSpec,
  attach: () => AgentAdapterSession | Promise<AgentAdapterSession>,
  disposeUnadopted?: () => void | Promise<void>,
  observe?: () => GrokSessionObserver,
  configured: GrokConfiguredIntent = {},
): PreparedGrokSession {
  let adoptedRuntimeSessionId: string | undefined;
  let adoptedSession: AgentAdapterSession | undefined;
  let disposed = false;

  return {
    sessionId,
    launch,
    async adopt(runtimeSessionId): Promise<AgentAdapterSession> {
      if (disposed) throw new Error('prepared Grok session is disposed');
      if (adoptedRuntimeSessionId && adoptedRuntimeSessionId !== runtimeSessionId) {
        throw new Error(`prepared Grok session is already adopted by ${adoptedRuntimeSessionId}`);
      }
      if (adoptedSession) return adoptedSession;
      adoptedRuntimeSessionId = runtimeSessionId;
      adoptedSession = createPendingControlSession(sessionId, runtimeSessionId, attach, observe?.(), configured);
      return adoptedSession;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      if (adoptedSession) await adoptedSession.dispose().catch(() => undefined);
      else await Promise.resolve(disposeUnadopted?.()).catch(() => undefined);
    },
  };
}

/** Build the native TUI invocation for a new or resumed leader-owned session. */
export function buildGrokTuiArgs(
  socketPath: string,
  sessionId: string,
  opts: Pick<CreateGrokSessionOptions, 'resume' | 'model' | 'permissionMode' | 'sandbox'>,
): string[] {
  const args: string[] = [];
  if (opts.model !== undefined) args.push('--model', opts.model);
  if (opts.permissionMode !== undefined) args.push('--permission-mode', opts.permissionMode);
  if (opts.sandbox !== undefined) args.push('--sandbox', opts.sandbox);
  args.push('--leader', '--leader-socket', socketPath);
  args.push(opts.resume ? '--resume' : '--session-id', sessionId);
  return args;
}

/** Open ACP control through the shared leader, optionally loading an existing session. */
async function openControl(
  executable: string,
  cwd: string,
  socketPath: string,
  sessionId: string | undefined,
  opts: Pick<CreateGrokSessionOptions, 'clientCapabilities' | 'onApproval' | 'onElicitation'>,
  env?: NodeJS.ProcessEnv,
): Promise<AgentAdapterSession> {
  const args = ['agent', '--leader', '--leader-socket', socketPath, 'stdio'];
  return createAcpSession({
    cwd,
    connector: createStdioAcpConnector({ executable, args, cwd, env }),
    ...(sessionId ? { resume: sessionId } : {}),
    clientCapabilities: opts.clientCapabilities,
    onApproval: opts.onApproval,
    onElicitation: opts.onElicitation,
    onExtensionNotification: grokExtensionEvents,
  });
}

/**
 * A Grok TUI session whose ACP control client attaches asynchronously. The TUI
 * is usable immediately; observation and prompt injection bind once attach
 * succeeds.
 */
export function createPendingControlSession(
  sessionId: string,
  runtimeSessionId: string,
  attach: () => AgentAdapterSession | Promise<AgentAdapterSession>,
  observer?: GrokSessionObserver,
  configured: GrokConfiguredIntent = {},
): AgentAdapterSession {
  const events = new BufferedAgentEventSource();
  let control: AgentAdapterSession | undefined;
  let disposed = false;
  // TUI conversation and lifecycle are authoritative in Grok's persisted
  // structured log. ACP remains a control/approval side channel.
  let observation: ObservationLevel = observer ? 'native-log' : 'structured';
  const stamper = createEnvelopeStamper();
  const monitorEvidence = new GrokMonitorEvidence({ nativeSessionId: () => sessionId });
  let activeTurnId: string | undefined;
  let unsubscribeControl: (() => void) | undefined;
  let unsubscribeObserver: (() => void) | undefined;
  let unsubscribeObserverError: (() => void) | undefined;
  let protocolContextAvailable = false;
  let controlDegraded = false;

  function emitMonitorBatch(batch: AdapterMonitorObservationBatch | null): void {
    if (!batch) return;
    publish(
      stamper.next({
        sessionId,
        nativeSessionId: sessionId,
        timestamp: batch.observedAt,
        monotonicTime: performance.now(),
        source: 'native-protocol',
        confidence: 'authoritative',
        event: { type: 'monitor.batch', batch },
      }),
    );
  }

  const capabilitiesBatch = monitorEvidence.capabilitiesBatch(new Date().toISOString());
  emitMonitorBatch(capabilitiesBatch);
  emitMonitorBatch(monitorEvidence.configuredBatch(configured, new Date().toISOString()));

  function publish(envelope: AgentEventEnvelope): void {
    events.emit(envelope);
  }

  function applyObserved(observed: GrokObservedEvent, monitorAlreadyObserved = false): void {
    if (
      protocolContextAvailable &&
      observed.source === 'native-log' &&
      observed.event.type.startsWith('context-window.')
    ) {
      return;
    }
    if (!monitorAlreadyObserved) {
      emitMonitorBatch(monitorEvidence.observedBatch(observed, observed.timestamp ?? new Date().toISOString()));
    }
    const observedTurnId =
      observed.promptId ??
      (observed.event.type === 'turn.started' ||
      observed.event.type === 'turn.completed' ||
      observed.event.type === 'turn.failed'
        ? observed.event.turnId
        : undefined);
    if (observed.event.type === 'turn.started') activeTurnId = observedTurnId;
    publish(
      stamper.next({
        sessionId,
        nativeSessionId: sessionId,
        promptId: observed.promptId,
        turnId: observedTurnId,
        timestamp: observed.timestamp ?? new Date().toISOString(),
        monotonicTime: performance.now(),
        source: observed.source ?? 'native-transcript',
        confidence: observed.confidence ?? 'authoritative',
        replay: observed.phase === 'bootstrap',
        event: observed.event,
        nativeEvent: observed.nativeEvent,
      }),
    );
    if (observed.event.type === 'turn.completed' || observed.event.type === 'turn.failed') activeTurnId = undefined;
  }

  function degradeControl(error: unknown, code: 'grok-control-attach-failed' | 'grok-control-closed'): void {
    if (controlDegraded || disposed) return;
    controlDegraded = true;
    const message = error instanceof Error ? error.message : String(error);
    const envelope = stamper.next({
      sessionId,
      nativeSessionId: sessionId,
      timestamp: new Date().toISOString(),
      monotonicTime: performance.now(),
      source: 'runtime',
      confidence: 'derived',
      event: {
        type: 'adapter.native-event',
        adapter: 'grok',
        nativeType: 'control.unavailable',
        diagnostic: { code, message },
      },
      nativeEvent: { code, message },
    });
    publish(envelope);
    if (!observer) observation = 'terminal-only';
    emitMonitorBatch(monitorEvidence.controlUnavailableBatch(envelope.timestamp, observer !== undefined));
  }

  function bindControl(acp: AgentAdapterSession): AgentAdapterSession | undefined {
    if (disposed) {
      void acp.dispose().catch(() => undefined);
      return undefined;
    }
    control = acp;
    unsubscribeControl = acp.onEvent((envelope) => {
      if (envelope.event.type === 'monitor.batch') {
        applyObserved(
          {
            event: envelope.event,
            timestamp: envelope.timestamp,
            phase: envelope.replay ? 'bootstrap' : 'live',
            source: envelope.source,
            confidence: envelope.confidence,
            nativeEvent: envelope.nativeEvent,
          },
          true,
        );
        return;
      }
      emitMonitorBatch(monitorEvidence.controlEnvelopeBatch(envelope));
      const acpTransportClosed =
        envelope.event.type === 'adapter.native-event' &&
        envelope.event.adapter === 'acp' &&
        envelope.event.nativeType === 'transport.closed';
      if (acpTransportClosed || envelope.event.type === 'process.exited' || envelope.event.type === 'session.exited') {
        degradeControl(new Error('Grok ACP control transport closed'), 'grok-control-closed');
        return;
      }
      // The native log owns TUI conversation and lifecycle. ACP remains the
      // live authority for host-side permissions and standard context usage.
      const allowedWithObserver = [
        'permission.requested',
        'permission.resolved',
        'context-window.updated',
        'context-window.invalidated',
        'session.environment.updated',
      ];
      const liveNativeTruth = envelope.event.type === 'adapter.native-event' && envelope.event.adapter === 'grok';
      if (observer && !allowedWithObserver.includes(envelope.event.type) && !liveNativeTruth) return;
      if (envelope.event.type.startsWith('context-window.')) protocolContextAvailable = true;
      applyObserved(
        {
          event: envelope.event,
          promptId: envelope.promptId ?? envelope.turnId ?? activeTurnId,
          timestamp: envelope.timestamp,
          phase: envelope.replay ? 'bootstrap' : 'live',
          source: envelope.source,
          confidence: envelope.confidence,
          nativeEvent: envelope.nativeEvent,
        },
        true,
      );
    });
    applyObserved({
      event: { type: 'session.ready' },
      source: 'runtime',
      confidence: 'authoritative',
      nativeEvent: { code: 'grok-control-attached' },
    });
    return acp;
  }

  if (observer) {
    unsubscribeObserver = observer.onEvent(applyObserved);
    unsubscribeObserverError = observer.onError((error) => {
      applyObserved({
        event: { type: 'adapter.native-event', adapter: 'grok', nativeType: 'updates-log-error' },
        source: 'runtime',
        confidence: 'derived',
        nativeEvent: { message: error.message },
      });
    });
    // Start after listeners are wired. The async read gives the runtime time to
    // subscribe while still catching records written before terminal adoption.
    void observer.poll();
  }

  let controlReady: Promise<AgentAdapterSession | undefined>;
  try {
    const attached = attach();
    if (typeof (attached as Promise<AgentAdapterSession>).then === 'function') {
      controlReady = Promise.resolve(attached)
        .then(bindControl)
        .catch((error: unknown) => {
          degradeControl(error, 'grok-control-attach-failed');
          return undefined;
        });
    } else {
      controlReady = Promise.resolve(bindControl(attached as AgentAdapterSession));
    }
  } catch (error) {
    degradeControl(error, 'grok-control-attach-failed');
    controlReady = Promise.resolve(undefined);
  }

  return {
    sessionId,
    runtimeSessionId,
    observationLevel: () => observation,
    onEvent(listener) {
      if (disposed) return () => undefined;
      return events.onEvent(listener);
    },
    async submitPrompt(submission: PromptSubmission): Promise<PromptReceipt> {
      const acp = control ?? (await controlReady.catch(() => undefined));
      if (!acp) return { status: 'rejected', reason: 'grok control client not attached' };
      return acp.submitPrompt(submission);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeControl?.();
      unsubscribeObserver?.();
      unsubscribeObserverError?.();
      observer?.stop();
      events.close();
      if (control) await control.dispose().catch(() => undefined);
    },
  };
}

export function createGrokBackend(options: CreateGrokBackendOptions): GrokBackend {
  const executable = options.executable ?? 'grok';
  const host = options.host;
  let ownedImposterHome: string | undefined;
  const childExtras = options.appServerEnv ? { ...options.appServerEnv } : undefined;
  // All three Grok processes and the parent-side observer must share one home.
  // Godview intentionally supplies only AI_PERSONA; allocate the isolation root
  // here, where the full multi-process recipe is owned, and clean it with the
  // backend. Real Grok launches (no appServerEnv) retain normal GROK_HOME rules.
  if (childExtras?.AI_PERSONA === 'grok') {
    if (
      childExtras.CHOPSTICKS_IMPOSTER_HOME &&
      childExtras.GROK_HOME &&
      resolve(childExtras.CHOPSTICKS_IMPOSTER_HOME) !== resolve(childExtras.GROK_HOME)
    ) {
      throw new Error('Grok Imposter requires CHOPSTICKS_IMPOSTER_HOME and GROK_HOME to name the same root');
    }
    const configured = childExtras.CHOPSTICKS_IMPOSTER_HOME ?? childExtras.GROK_HOME;
    const imposterHome = configured ?? mkdtempSync(join(realpathSync(tmpdir()), 'chopsticks-grok-imposter-home-'));
    if (!configured) ownedImposterHome = imposterHome;
    childExtras.CHOPSTICKS_IMPOSTER_HOME = imposterHome;
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
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chopsticks-grok-'));
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
    const control = await openControl(executable, cwd, socketPath, resume, opts, childEnv);
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

    async createSession(opts): Promise<AgentAdapterSession> {
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
