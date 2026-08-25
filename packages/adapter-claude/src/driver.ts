/**
 * Claude session driver — the composition layer (DESIGN §11, §16).
 *
 * Runs HUB-SIDE (Electron main / future daemon), never in the pty-host: the
 * host stays Claude-agnostic. The driver owns observation and control only;
 * PROCESS lifecycle (spawn/terminate) belongs to the host behind the injected
 * ports:
 *
 *   prepare (settings + UUID join contract)
 *     → ports.spawn (the host carries the hook token in its explicit env grant)
 *     → hook bridge (loopback HTTP; the ONLY session it accepts is ours)
 *     → normalizer → envelope stamping → normalized event stream
 *     → semantic provider (lazy: attached at the first hook envelope whose
 *       payload hands us transcript_path; every envelope supplies a poll hint)
 *     → prompt injector (uses ports.automate; confirmation and
 *       permission gating wired from the normalized event stream)
 *
 * Observation level (DESIGN §19.2) is reported honestly: 'terminal-only'
 * until the first hook arrives, 'native-hooks' after.
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  BufferedAgentEventSource,
  createEnvelopeStamper,
  type AgentEvent,
  type AgentEventConfidence,
  type AgentEventEnvelope,
  type AgentAdapterSession,
  type MonitorArtifactReadResult,
  type ObservationLevel,
  type TerminalAutomationOperation,
  type TerminalAutomationResult,
} from '@vibecook/puppeteer-core';
import type { AdapterMonitorObservationBatch } from '@vibecook/puppeteer-core/monitor-spi';
import { createHookBridge, type HookBridge, type HookBridgeOptions } from './observation/hook-bridge.js';
import { ClaudeHookNormalizer, type ClaudeHookDiagnostic, type ClaudeHookPayload } from './normalizer.js';
import { prepareClaudeSession, cleanupClaudeSession, type PreparedClaudeSession } from './launch/prepare.js';
import { createPromptInjector, type PromptInjector } from './launch/prompt.js';
import { observeClaudeStatusLineAccountUsage } from './observation/account-usage.js';
import { claudeContextWindowEvent, claudeEnvironmentEvent } from './observation/status-channel.js';
import { ClaudeMonitorEvidence } from './observation/monitor-evidence.js';
import {
  SpaghettiScopedObservationProvider,
  type SpaghettiScopedObservationDiagnostic,
} from './observation/spaghetti-scoped.js';
import { claudePermissionMode } from './provider-modes.js';
import type {
  SemanticObservationHandle,
  SemanticObservationPollHint,
  SemanticObservationProvider,
} from './observation/semantic-provider.js';

const TOKEN_ENV_VAR = 'PUPPETEER_HOOK_TOKEN';

function hookEventConfidence(
  hookEventName: string,
  event: AgentEvent,
  payload: ClaudeHookPayload,
): AgentEventConfidence {
  if (
    event.type === 'question.requested' ||
    (event.type === 'plan.updated' && event.provisional) ||
    (event.type === 'task.updated' && event.provisional) ||
    event.type === 'teammate.idle' ||
    (hookEventName === 'PreCompact' && event.type === 'compaction.started') ||
    (['Stop', 'StopFailure', 'SessionEnd', 'PreCompact', 'UserPromptSubmit'].includes(hookEventName) &&
      event.type === 'compaction.completed') ||
    (['tool.requested', 'tool.started', 'tool.completed', 'tool.failed'].includes(event.type) &&
      typeof payload.tool_use_id !== 'string')
  ) {
    return 'inferred';
  }
  return 'authoritative';
}

function payloadVersion(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const body = payload as Record<string, unknown>;
  return typeof body.version === 'string'
    ? body.version
    : typeof body.claude_version === 'string'
      ? body.claude_version
      : undefined;
}

export interface ClaudeSessionPorts {
  /** Spawn the prepared command; resolves with the host's session id for writes. */
  spawn(prepared: PreparedClaudeSession): Promise<{ runtimeSessionId: string }>;
  /** Ordered semantic automation; never attaches a view or claims layout. */
  automate(runtimeSessionId: string, operation: TerminalAutomationOperation): Promise<TerminalAutomationResult>;
}

export interface CreateClaudeSessionOptions {
  cwd: string;
  ports: ClaudeSessionPorts;
  title?: string;
  executable?: string;
  permissionMode?: string;
  /** Model alias or full model id passed through to Claude Code. */
  model?: string;
  /** Claude Code binary version detected before launch, when available. */
  providerVersion?: string;
  /** Open-ended effort intent passed through to Claude Code. */
  effort?: string;
  /** Native settings layers loaded by Claude and considered for status-line delegation. */
  settingSources?: readonly import('./observation/status-channel.js').ClaudeSettingSource[];
  /** Claude user configuration root when the launching environment relocates it. */
  configDir?: string;
  /** Opt into Claude FileChanged observation with its native filename matcher syntax. */
  fileChangeMatcher?: string;
  /**
   * Resume an existing session by id (native `--resume`; the session keeps its
   * transcript and id—packages/surface/vendors/claude/findings.md §6). Omit to start fresh.
   */
  resume?: string;
  /** Preserve Claude's native resume picker/continue selection after launch. */
  resumeInvocation?: string[];
  /** Observer fallback cadence; hook envelopes are the primary poll signal. */
  transcriptPollIntervalMs?: number;
  /** Non-blocking reports for malformed known hooks retained as native evidence. */
  onDiagnostic?: (diagnostic: ClaudeHookDiagnostic) => void;
  /** Low-latency signal for a semantic observer to poll after a native hook. */
  onObservationPollHint?: (hint: ClaudeObservationPollHint) => void;
  /** Injectable bridge factory for deterministic transport-failure tests. */
  hookBridgeFactory?: (options: HookBridgeOptions) => HookBridge;
  /**
   * Explicit fault injection for native canaries. After the selected accepted
   * hook, close only the observation bridge while leaving Claude and its
   * semantic transcript observer alive. Never set this for product sessions.
   */
  hookRailFaultInjection?: ClaudeHookRailFaultInjection;
  /** Injectable semantic source; defaults to Spaghetti's scoped typed observer. */
  semanticProviderFactory?: () => SemanticObservationProvider;
  /** Optional tap of the authoritative typed Spaghetti batches for diagnostics. */
  onScopedObservationBatch?: (batch: AdapterMonitorObservationBatch) => void;
  /** Bounded RFC-012D control diagnostics. */
  onScopedObservationDiagnostic?: (diagnostic: SpaghettiScopedObservationDiagnostic) => void;
  /** Observation errors are reported without terminating Claude. */
  onScopedObservationError?: (error: Error) => void;
  /** Install and consume Claude's child status channel. Defaults to true for direct adapter callers. */
  observeSubagentStatus?: boolean;
}

export interface ClaudeHookRailFaultInjection {
  afterHookEvent: string;
  occurrence?: number;
  reason?: string;
}

export interface ClaudeObservationPollHint {
  hookEventName: string;
  nativeSessionId?: string;
  promptId?: string;
  agentId?: string;
  agentType?: string;
}

/**
 * The core adapter handle (sessionId is the `--session-id` UUID = the
 * puppeteer ↔ spaghetti join contract) plus Claude-specific transcript extras.
 */
export interface ClaudeSession extends AgentAdapterSession {
  /** Absolute path to this session's transcript JSONL (handed to us by hooks). */
  transcriptPath(): string | undefined;
  /** Force a transcript delta parse now (tests, explicit refresh). */
  pollTranscript(): Promise<void>;
  readMonitorArtifact(artifactId: string, options: { maxBytes: number }): Promise<MonitorArtifactReadResult>;
}

export interface PrepareClaudeTuiSessionOptions extends Omit<CreateClaudeSessionOptions, 'ports'> {
  /** Route semantic automation to a terminal after the preparation is adopted. */
  automate(runtimeSessionId: string, operation: TerminalAutomationOperation): Promise<TerminalAutomationResult>;
}

/**
 * A live Claude hook bridge plus an authoritative launch recipe that has not
 * yet been bound to a host terminal. Call `adopt` before executing `launch` so
 * the runtime is subscribed before Claude can emit its first hook.
 */
export interface PreparedClaudeTuiSession {
  readonly sessionId: string;
  readonly launch: PreparedClaudeSession;
  adopt(runtimeSessionId: string): Promise<ClaudeSession>;
  dispose(): Promise<void>;
}

export async function prepareClaudeTuiSession(
  options: PrepareClaudeTuiSessionOptions,
): Promise<PreparedClaudeTuiSession> {
  if (options.resume && options.resumeInvocation) {
    throw new Error('Claude preparation accepts resume or resumeInvocation, not both');
  }
  // Session id first: the bridge must be able to enforce its allow-list from
  // the instant it starts listening, with no window where the closure could
  // dereference a not-yet-prepared session. On resume the id is the session
  // being resumed (it keeps its own id); otherwise mint a fresh one.
  const sessionId = options.resume ?? randomUUID();
  let selectedSessionId = options.resume ?? (options.resumeInvocation ? undefined : sessionId);
  let selectionLocked = options.resume !== undefined;
  const bridge: HookBridge = (options.hookBridgeFactory ?? createHookBridge)({
    allowSession: (id, kind, body) => {
      // `/clear` is a native in-process identity rotation regardless of how
      // the original conversation was selected. Once authenticated, its
      // SessionStart becomes the new allow-list claim and stale ids are denied.
      if (kind === 'hook' && body.hook_event_name === 'SessionStart' && body.source === 'clear') {
        selectedSessionId = id;
        selectionLocked = true;
        return true;
      }
      if (!options.resumeInvocation) {
        return id === selectedSessionId;
      }
      // The native resume picker renders status lines for the currently
      // highlighted conversation before the user commits a selection. That
      // preview must not claim the bridge. Claude can also emit SessionStart
      // for a picker preview before it emits the final resumed SessionStart,
      // so SessionStart may rebind only until the selected session reaches its
      // boot-finished InstructionsLoaded hook.
      if ((kind === 'statusline' || kind === 'subagent-statusline') && selectedSessionId === undefined) return true;
      if (kind === 'hook' && body.hook_event_name === 'SessionStart') {
        if (selectionLocked) return id === selectedSessionId;
        selectedSessionId = id;
        return true;
      }
      selectedSessionId ??= id;
      if (id !== selectedSessionId) return false;
      if (kind === 'hook' && body.hook_event_name === 'InstructionsLoaded' && body.load_reason === 'session_start') {
        selectionLocked = true;
      }
      return true;
    },
  });
  await bridge.start();

  try {
    const prepared = await prepareClaudeSession({
      cwd: options.cwd,
      sessionId,
      resume: options.resume,
      resumeInvocation: options.resumeInvocation,
      title: options.title,
      executable: options.executable,
      permissionMode: options.permissionMode,
      model: options.model,
      effort: options.effort,
      settingSources: options.settingSources,
      configDir: options.configDir,
      fileChangeMatcher: options.fileChangeMatcher,
      endpoint: bridge.endpoint(),
      statusLineEndpoint: bridge.statusLineEndpoint(),
      ...(options.observeSubagentStatus === false
        ? {}
        : { subagentStatusLineEndpoint: bridge.subagentStatusLineEndpoint() }),
      tokenEnvVar: TOKEN_ENV_VAR,
      token: bridge.token,
    });

    try {
      return createPreparedClaudeSession(options, bridge, prepared, () => selectedSessionId ?? prepared.sessionId);
    } catch (error) {
      await cleanupClaudeSession(prepared);
      throw error;
    }
  } catch (err) {
    await bridge.dispose();
    throw err;
  }
}

function createPreparedClaudeSession(
  options: PrepareClaudeTuiSessionOptions,
  bridge: HookBridge,
  prepared: PreparedClaudeSession,
  nativeSessionId: () => string = () => prepared.sessionId,
): PreparedClaudeTuiSession {
  const normalizer = new ClaudeHookNormalizer();
  const stamper = createEnvelopeStamper();
  const events = new BufferedAgentEventSource();
  let observation: ObservationLevel = 'terminal-only';
  let transcriptPath: string | undefined;
  const semanticProvider =
    options.semanticProviderFactory?.() ??
    new SpaghettiScopedObservationProvider({
      onDiagnostic: options.onScopedObservationDiagnostic,
    });
  const semanticCapabilities = Promise.resolve().then(() => semanticProvider.capabilities());
  const monitorEvidence = new ClaudeMonitorEvidence({ nativeSessionId });
  let semanticHandle: SemanticObservationHandle | undefined;
  let semanticAttachment: Promise<SemanticObservationHandle | undefined> | undefined;
  let semanticGeneration = 0;
  let hasSemanticAttachment = false;
  let historyBootstrap: Promise<void> | undefined;
  let adoptedRuntimeSessionId: string | undefined;
  let adoptedSession: ClaudeSession | undefined;
  let disposed = false;
  let capabilitiesBatch = monitorEvidence.capabilitiesBatch(new Date().toISOString());
  let semanticCapabilitiesPublished = false;
  let hookRailAvailable = true;
  let hookRailUnavailableReason = 'Claude hook bridge unavailable';
  let matchingFaultHooks = 0;
  let hookRailFaultInjected = false;
  const pendingPermissionIds = new Set<string>();
  const pendingQuestionIds = new Set<string>();
  let configuredIntentPublished = false;
  let observedStatusEnvironmentKey: string | undefined;
  let observedStatusContextKey: string | undefined;

  const injector: PromptInjector = createPromptInjector({
    automate: (operation) => {
      if (!adoptedRuntimeSessionId) {
        return Promise.resolve({ accepted: false, reason: 'prepared Claude session is not adopted' });
      }
      return options.automate(adoptedRuntimeSessionId, operation);
    },
  });

  function emitMonitorBatch(batch: AdapterMonitorObservationBatch): void {
    apply(
      { type: 'monitor.batch', batch },
      {
        source: 'native-protocol',
        timestamp: batch.observedAt,
        confidence: 'authoritative',
      },
    );
  }

  emitMonitorBatch(capabilitiesBatch);

  async function publishCapabilities(): Promise<void> {
    if (semanticCapabilitiesPublished || disposed) return;
    semanticCapabilitiesPublished = true;
    const semantic = await semanticCapabilities.catch(() => []);
    if (disposed) return;
    const batch = monitorEvidence.capabilitiesBatch(new Date().toISOString());
    const byFamily = new Map(batch.capabilities?.map((capability) => [capability.family, capability]) ?? []);
    for (const capability of semantic) {
      const current = byFamily.get(capability.family);
      if (!current || (current.support === 'unsupported' && capability.support !== 'unsupported')) {
        byFamily.set(capability.family, capability);
      }
    }
    const merged = { ...batch, capabilities: [...byFamily.values()] };
    capabilitiesBatch = hookRailAvailable
      ? merged
      : monitorEvidence.hookRailUnavailableBatch(
          new Date().toISOString(),
          hookRailUnavailableReason,
          merged.capabilities,
        );
    emitMonitorBatch(capabilitiesBatch);
  }

  function apply(
    event: AgentEvent,
    meta: {
      source: AgentEventEnvelope['source'];
      timestamp: string;
      promptId?: string;
      turnId?: string;
      agentId?: string;
      agentType?: string;
      providerVersion?: string;
      confidence?: AgentEventConfidence;
      native?: unknown;
      replay?: boolean;
    },
  ): AgentEventEnvelope {
    const envelope = stamper.next({
      sessionId: nativeSessionId(),
      nativeSessionId: nativeSessionId(),
      promptId: meta.promptId,
      turnId: meta.turnId,
      agentId: meta.agentId,
      agentType: meta.agentType,
      providerVersion: meta.providerVersion ?? options.providerVersion,
      timestamp: meta.timestamp,
      monotonicTime: performance.now(),
      source: meta.source,
      confidence: meta.confidence ?? 'authoritative',
      ...(meta.replay ? { replay: true } : {}),
      event,
      nativeEvent: meta.native,
    });
    // Injector wiring rides the normalized stream, not raw payloads.
    switch (event.type) {
      case 'turn.started':
        injector.handleTurnStarted(event.turnId, event.prompt);
        break;
      case 'permission.requested':
        pendingPermissionIds.add(event.requestId);
        injector.setPermissionPending(pendingPermissionIds.size > 0);
        break;
      case 'permission.resolved':
        pendingPermissionIds.delete(event.requestId);
        injector.setPermissionPending(pendingPermissionIds.size > 0);
        break;
      case 'question.requested':
        pendingQuestionIds.add(event.requestId);
        injector.setQuestionPending(pendingQuestionIds.size > 0);
        break;
      case 'question.resolved':
        pendingQuestionIds.delete(event.requestId);
        injector.setQuestionPending(pendingQuestionIds.size > 0);
        break;
      case 'session.started':
        if (!event.rebind) break;
        pendingPermissionIds.clear();
        pendingQuestionIds.clear();
        injector.setPermissionPending(false);
        injector.setQuestionPending(false);
        break;
      // A native boundary is authoritative even if an older Claude release
      // omitted a resolution signal for one request.
      case 'turn.completed':
      case 'turn.failed':
      case 'session.exited':
        pendingPermissionIds.clear();
        pendingQuestionIds.clear();
        injector.setPermissionPending(false);
        injector.setQuestionPending(false);
        break;
    }

    events.emit(envelope);
    return envelope;
  }

  function publishConfiguredIntent(): void {
    if (configuredIntentPublished) return;
    configuredIntentPublished = true;
    apply(
      {
        type: 'session.environment.updated',
        intent: 'configured',
        ...(options.model ? { model: { id: options.model, provider: 'anthropic' } } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        providerPermissionMode: claudePermissionMode(options.permissionMode ?? 'default'),
      },
      {
        source: 'runtime',
        timestamp: new Date().toISOString(),
        providerVersion: options.providerVersion,
      },
    );
  }

  const reportHookRailUnavailable = (reason: string): void => {
    if (disposed || !hookRailAvailable) return;
    const observedAt = new Date().toISOString();
    hookRailAvailable = false;
    hookRailUnavailableReason = reason;
    observation = semanticHandle ? 'native-log' : 'terminal-only';
    capabilitiesBatch = monitorEvidence.hookRailUnavailableBatch(observedAt, reason, capabilitiesBatch.capabilities);
    emitMonitorBatch(capabilitiesBatch);
    apply(
      { type: 'adapter.native-event', adapter: 'claude-code', nativeType: 'hook-bridge.unavailable' },
      {
        source: 'runtime',
        timestamp: observedAt,
        providerVersion: options.providerVersion,
        native: { reason },
      },
    );
  };

  bridge.onUnavailable(reportHookRailUnavailable);

  function ensureSemanticProvider(path: string): void {
    if (semanticAttachment && transcriptPath === path) return;
    semanticGeneration += 1;
    const generation = semanticGeneration;
    const priorAttachment = semanticAttachment;
    const bootstrap =
      !hasSemanticAttachment && (options.resume !== undefined || options.resumeInvocation !== undefined);
    transcriptPath = path;
    const nextAttachment = (async (): Promise<SemanticObservationHandle | undefined> => {
      const prior = await priorAttachment?.catch(() => undefined);
      await prior?.dispose();
      await semanticCapabilities;
      if (disposed || generation !== semanticGeneration) return undefined;
      const handle = await semanticProvider.attach({
        nativeSessionId: nativeSessionId(),
        transcriptPath: path,
        bootstrap,
        pollIntervalMs: options.transcriptPollIntervalMs,
      });
      if (disposed || generation !== semanticGeneration) {
        await handle.dispose();
        return undefined;
      }
      semanticHandle = handle;
      handle.onEvent((semantic) => {
        if (disposed || generation !== semanticGeneration) return;
        apply(semantic.event, {
          source: 'native-transcript',
          timestamp: semantic.timestamp,
          promptId: semantic.promptId,
          turnId: semantic.turnId,
          agentId: semantic.agentId,
          agentType: semantic.agentType,
          native: semantic.nativeEvent,
          replay: semantic.replay,
        });
      });
      handle.onBatch((batch) => {
        if (disposed || generation !== semanticGeneration) return;
        try {
          options.onScopedObservationBatch?.(batch);
        } catch {
          // Diagnostic taps cannot affect authoritative monitor delivery.
        }
        emitMonitorBatch(batch);
      });
      handle.onError((error) => {
        try {
          options.onScopedObservationError?.(error);
        } catch {
          // Error diagnostics cannot affect Claude or source recovery.
        }
        // Semantic rail loss degrades its own batches; hooks and the TUI continue.
      });
      try {
        await handle.poll();
      } catch (error) {
        if (semanticHandle === handle) semanticHandle = undefined;
        await handle.dispose();
        throw error;
      }
      hasSemanticAttachment = true;
      return handle;
    })().catch((error: unknown) => {
      if (!disposed && generation === semanticGeneration) {
        if (semanticAttachment === nextAttachment) semanticAttachment = undefined;
        historyBootstrap = undefined;
        apply(
          { type: 'adapter.native-event', adapter: 'claude-code', nativeType: 'semantic-observer.unavailable' },
          {
            source: 'runtime',
            timestamp: new Date().toISOString(),
            native: { error: error instanceof Error ? error.message : String(error) },
          },
        );
      }
      return undefined;
    });
    semanticAttachment = nextAttachment;
    historyBootstrap = bootstrap ? nextAttachment.then(() => undefined) : undefined;
  }

  function pollSemantic(hint?: SemanticObservationPollHint): void {
    void semanticAttachment
      ?.then((handle) => handle?.poll(hint))
      .catch(() => {
        // The provider reports its own degraded readiness; hooks continue.
      });
  }

  bridge.onEvent((hookEnvelope) => {
    observation = 'native-hooks';
    const body = hookEnvelope.body as ClaudeHookPayload;
    const normalized = normalizer.normalize(body);
    for (const diagnostic of normalized.diagnostics) {
      try {
        options.onDiagnostic?.(diagnostic);
      } catch {
        // Diagnostic consumers must not affect Claude or the normalized stream.
      }
    }
    // A picker preview can emit SessionStart. Wait for the selected session's
    // boot-finished hook before binding its durable transcript.
    if (
      normalized.transcriptPath &&
      (!options.resumeInvocation ||
        (body.hook_event_name === 'InstructionsLoaded' && body.load_reason === 'session_start'))
    ) {
      ensureSemanticProvider(normalized.transcriptPath);
    }
    const deliver = (): void => {
      const hookEventName = typeof body.hook_event_name === 'string' ? body.hook_event_name : 'unknown';
      if (normalized.sessionId) monitorEvidence.observeNativeSession(normalized.sessionId);
      if (normalized.agentId) {
        if (hookEventName === 'SubagentStart') {
          monitorEvidence.observeNativeAgentStarted(normalized.agentId, normalized.agentType);
        } else if (hookEventName === 'SubagentStop') {
          monitorEvidence.observeNativeAgentStopped(normalized.agentId, normalized.agentType);
        } else {
          monitorEvidence.observeNativeAgent(normalized.agentId, normalized.agentType);
        }
      }
      for (const event of normalized.events) {
        if (event.type === 'context-window.invalidated') {
          emitMonitorBatch(
            monitorEvidence.rootContextInvalidationBatch(hookEnvelope.receivedAt, hookEnvelope.requestId),
          );
        }
        apply(event, {
          source: 'native-hook',
          timestamp: hookEnvelope.receivedAt,
          promptId: normalized.promptId,
          turnId: normalized.turnId,
          agentId: normalized.agentId,
          agentType: normalized.agentType,
          providerVersion: normalized.providerVersion,
          confidence: hookEventConfidence(hookEventName, event, body),
          native: body,
        });
      }
      try {
        options.onObservationPollHint?.({
          hookEventName,
          nativeSessionId: normalized.sessionId,
          promptId: normalized.promptId,
          agentId: normalized.agentId,
          agentType: normalized.agentType,
        });
      } catch {
        // Poll hints are advisory and cannot affect hook ingestion.
      }
      // Hooks fire near transcript appends — poke the semantic source instead
      // of waiting out its fallback interval.
      pollSemantic({
        hookEventName,
        nativeSessionId: normalized.sessionId,
        promptId: normalized.promptId,
        agentId: normalized.agentId,
        agentType: normalized.agentType,
      });

      const fault = options.hookRailFaultInjection;
      if (!fault || hookRailFaultInjected || hookEventName !== fault.afterHookEvent) return;
      matchingFaultHooks += 1;
      if (matchingFaultHooks < (fault.occurrence ?? 1)) return;
      hookRailFaultInjected = true;
      const reason = fault.reason ?? `Claude hook bridge canary fault after ${hookEventName}`;
      // The current hook has already been acknowledged by HookBridge. Close
      // the real listener on the next microtask, then publish rail degradation
      // directly because intentional disposal correctly suppresses the
      // bridge's unexpected-close callback.
      queueMicrotask(() => {
        void bridge.dispose().then(
          () => reportHookRailUnavailable(reason),
          () => reportHookRailUnavailable(reason),
        );
      });
    };

    // SessionStart establishes identity, then durable history must be
    // projected before any newer hook mutates state. Promise callbacks retain
    // bridge arrival order, forming the Claude equivalent of Codex's replay
    // barrier.
    if (historyBootstrap && body.hook_event_name !== 'SessionStart') {
      void historyBootstrap.then(deliver);
    } else {
      deliver();
    }
  });

  bridge.onStatusLine((statusEnvelope) => {
    // Account usage is process-global (subscription quota), not session state.
    observeClaudeStatusLineAccountUsage(statusEnvelope.body, statusEnvelope.receivedAt);
    const monitorBatch = monitorEvidence.rootStatusBatch(
      statusEnvelope.body,
      statusEnvelope.receivedAt,
      statusEnvelope.requestId,
    );
    if (monitorBatch) emitMonitorBatch(monitorBatch);

    const environment = claudeEnvironmentEvent(statusEnvelope.body);
    if (environment) {
      const environmentKey = JSON.stringify(environment);
      if (environmentKey !== observedStatusEnvironmentKey) {
        observedStatusEnvironmentKey = environmentKey;
        apply(environment, {
          source: 'native-statusline',
          timestamp: statusEnvelope.receivedAt,
          providerVersion: payloadVersion(statusEnvelope.body),
          native: statusEnvelope.body,
        });
      }
    }

    const contextEvent = claudeContextWindowEvent(statusEnvelope.body);
    if (!contextEvent) return;
    if (contextEvent.type === 'context-window.invalidated') {
      if (!observedStatusContextKey) return;
      observedStatusContextKey = undefined;
    } else {
      const contextKey = JSON.stringify(contextEvent);
      if (contextKey === observedStatusContextKey) return;
      observedStatusContextKey = contextKey;
    }
    apply(contextEvent, {
      source: 'native-statusline',
      timestamp: statusEnvelope.receivedAt,
      providerVersion: payloadVersion(statusEnvelope.body),
      native: statusEnvelope.body,
    });
  });

  if (options.observeSubagentStatus !== false) {
    bridge.onSubagentStatusLine((statusEnvelope) => {
      const batch = monitorEvidence.childStatusBatch(
        statusEnvelope.body,
        statusEnvelope.receivedAt,
        statusEnvelope.requestId,
      );
      if (batch) emitMonitorBatch(batch);
    });
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    events.close();
    const attached = await semanticAttachment?.catch(() => undefined);
    await attached?.dispose();
    await bridge.dispose();
    await cleanupClaudeSession(prepared);
  }

  return {
    sessionId: prepared.sessionId,
    launch: prepared,
    async adopt(runtimeSessionId): Promise<ClaudeSession> {
      if (disposed) throw new Error('prepared Claude session is disposed');
      if (adoptedRuntimeSessionId && adoptedRuntimeSessionId !== runtimeSessionId) {
        throw new Error(`prepared Claude session is already adopted by ${adoptedRuntimeSessionId}`);
      }
      if (adoptedSession) return adoptedSession;
      adoptedRuntimeSessionId = runtimeSessionId;
      adoptedSession = {
        get sessionId() {
          return nativeSessionId();
        },
        runtimeSessionId,
        observationLevel: () => observation,
        transcriptPath: () => transcriptPath,
        onEvent(listener) {
          const unsubscribe = events.onEvent(listener);
          publishConfiguredIntent();
          void publishCapabilities();
          return unsubscribe;
        },
        readMonitorArtifact: async (artifactId, artifactOptions) => {
          const handle = await semanticAttachment;
          if (!handle) {
            return { status: 'unavailable', message: 'Claude semantic observation is not attached' };
          }
          return handle.readArtifact(artifactId, artifactOptions);
        },
        submitPrompt: (submission) => injector.submit(submission),
        pollTranscript: async () => {
          await historyBootstrap;
          const handle = await semanticAttachment;
          await handle?.poll();
        },
        dispose,
      };
      return adoptedSession;
    },
    dispose,
  };
}

export async function createClaudeSession(options: CreateClaudeSessionOptions): Promise<ClaudeSession> {
  const prepared = await prepareClaudeTuiSession({
    cwd: options.cwd,
    title: options.title,
    executable: options.executable,
    permissionMode: options.permissionMode,
    model: options.model,
    effort: options.effort,
    settingSources: options.settingSources,
    configDir: options.configDir,
    providerVersion: options.providerVersion,
    fileChangeMatcher: options.fileChangeMatcher,
    resume: options.resume,
    resumeInvocation: options.resumeInvocation,
    transcriptPollIntervalMs: options.transcriptPollIntervalMs,
    onDiagnostic: options.onDiagnostic,
    onObservationPollHint: options.onObservationPollHint,
    hookBridgeFactory: options.hookBridgeFactory,
    hookRailFaultInjection: options.hookRailFaultInjection,
    semanticProviderFactory: options.semanticProviderFactory,
    onScopedObservationBatch: options.onScopedObservationBatch,
    onScopedObservationDiagnostic: options.onScopedObservationDiagnostic,
    onScopedObservationError: options.onScopedObservationError,
    observeSubagentStatus: options.observeSubagentStatus,
    automate: options.ports.automate,
  });
  try {
    const { runtimeSessionId } = await options.ports.spawn(prepared.launch);
    return await prepared.adopt(runtimeSessionId);
  } catch (err) {
    await prepared.dispose();
    throw err;
  }
}
