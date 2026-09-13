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
 *     → category normalizers → candidate event source → runtime ingress
 *     → live transcript provider (lazy: attached at the
 *       first hook payload that hands us transcript_path)
 *     → authenticated OTLP logs (settled request usage, when available)
 *     → prompt injector (uses ports.automate; confirmation and
 *       permission gating wired from the normalized event stream)
 *
 * Observation level (DESIGN §19.2) is reported honestly: 'terminal-only'
 * until the first hook arrives, 'native-hooks' after.
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type AgentEvent,
  type AgentEventConfidence,
  type AgentAdapterBinding,
  type BoundIngress,
  type HostIngress,
  type ObservationLevel,
  type TerminalAutomationOperation,
  type TerminalAutomationResult,
  type AdapterDisposeOptions,
} from '@vibecook/puppeteer-core';
import type { AdapterMonitorObservationBatch } from '@vibecook/puppeteer-core/monitor-spi';
import { createHookBridge, type HookBridge, type HookBridgeOptions } from './observation/hook-bridge.js';
import { ClaudeHookNormalizer, type ClaudeHookDiagnostic, type ClaudeHookPayload } from './normalization/index.js';
import {
  prepareClaudeSession,
  cleanupClaudeSession,
  hasClaudeOtelExporterConflict,
  locateClaudeTranscript,
  type PreparedClaudeSession,
} from './launch/prepare.js';
import { createClaudeArtifactService } from './services/artifacts.js';
import { createPromptInjector, type PromptInjector } from './services/prompt.js';
import { observeClaudeStatusLineAccountUsage } from './services/account-usage.js';
import { claudeContextWindowEvent, claudeEnvironmentEvents } from './observation/status-channel.js';
import { ClaudeMonitorEvidence } from './normalization/monitor.js';
import {
  decodeClaudeOtelLogs,
  isClaudeOtelLogsVerified,
  normalizeClaudeOtelModel,
  normalizeClaudeOtelUsage,
  normalizeClaudeOtelWorkflow,
  otelString,
  supportsClaudeOtelLogs,
} from './observation/otel/index.js';
import { ClaudeTranscriptObservationProvider } from './observation/transcript/provider.js';
import { claudePermissionMode } from './normalization/mode.js';
import { ClaudeEventSource, type ClaudeEventPublication } from './services/event-source.js';
import type {
  SemanticObservationHandle,
  SemanticObservationPollHint,
  SemanticObservationProvider,
} from './observation/semantic-provider.js';

const TOKEN_ENV_VAR = 'PUPPETEER_HOOK_TOKEN';
const MAX_OTEL_USAGE_FINGERPRINTS = 20_000;
const MAX_OTEL_ACTOR_FINGERPRINTS = 4_096;
const MAX_OTEL_WORKFLOW_FINGERPRINTS = 1_024;

function rememberFingerprint(
  fingerprints: Map<string, string>,
  key: string,
  fingerprint: string,
  capacity: number,
): void {
  fingerprints.delete(key);
  fingerprints.set(key, fingerprint);
  while (fingerprints.size > capacity) {
    const oldest = fingerprints.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    fingerprints.delete(oldest);
  }
}

function hookEventConfidence(
  hookEventName: string,
  event: AgentEvent,
  payload: ClaudeHookPayload,
): AgentEventConfidence {
  if (
    event.type === 'interaction:question-requested' ||
    event.type === 'delegation:teammate-idle' ||
    (hookEventName === 'PreCompact' && event.type === 'compaction:started') ||
    (['Stop', 'StopFailure', 'SessionEnd', 'PreCompact', 'UserPromptSubmit'].includes(hookEventName) &&
      event.type === 'compaction:completed') ||
    (['tool:requested', 'tool:started', 'tool:completed', 'tool:failed', 'workspace:file-operation'].includes(
      event.type,
    ) &&
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
  title?: string | undefined;
  executable?: string | undefined;
  /** Adapter-normalized launch environment; runtime consumers do not configure this directly. */
  env?: Record<string, string> | undefined;
  permissionMode?: string | undefined;
  /** Model alias or full model id passed through to Claude Code. */
  model?: string | undefined;
  /** Claude Code binary version detected before launch, when available. */
  providerVersion?: string | undefined;
  /** Open-ended effort intent passed through to Claude Code. */
  effort?: string | undefined;
  /** Native settings layers loaded by Claude and considered for status-line delegation. */
  settingSources?: readonly import('./observation/status-channel.js').ClaudeSettingSource[] | undefined;
  /** Claude user configuration root when the launching environment relocates it. */
  configDir?: string | undefined;
  /** Opt into Claude FileChanged observation with its native filename matcher syntax. */
  fileChangeMatcher?: string | undefined;
  /**
   * Resume an existing session by id (native `--resume`; the session keeps its
   * transcript and id—packages/surface/vendors/claude/findings.md §6). Omit to start fresh.
   */
  resume?: string | undefined;
  /** Preserve Claude's native resume picker/continue selection after launch. */
  resumeInvocation?: string[] | undefined;
  /** Observer fallback cadence; hook envelopes are the primary poll signal. */
  transcriptPollIntervalMs?: number | undefined;
  /** Non-blocking reports for malformed known hooks retained as native evidence. */
  onDiagnostic?: ((diagnostic: ClaudeHookDiagnostic) => void) | undefined;
  /**
   * Stable ingress (core `HostIngress`): pin the hook bridge's port and token
   * and learn what was bound before the process launches, so a host that
   * outlives its own process can re-attach (`attachClaudeTuiSession`).
   */
  ingress?: HostIngress | undefined;
  /** Injectable bridge factory for deterministic transport-failure tests. */
  hookBridgeFactory?: ((options: HookBridgeOptions) => HookBridge) | undefined;
  /**
   * Explicit fault injection for native canaries. After the selected accepted
   * hook, close only the observation bridge while leaving Claude and its
   * semantic transcript observer alive. Never set this for product sessions.
   */
  hookRailFaultInjection?: ClaudeHookRailFaultInjection | undefined;
  /** Injectable durable observer; defaults to live transcript updates. */
  semanticProviderFactory?: (() => SemanticObservationProvider) | undefined;
  /** Enable authenticated Claude OTLP request-completion logs. Defaults to true when no exporter conflict exists. */
  observeOtlpUsage?: boolean | undefined;
  /** Install and consume Claude's child status channel. Defaults to true for direct adapter callers. */
  observeSubagentStatus?: boolean | undefined;
}

export interface ClaudeHookRailFaultInjection {
  afterHookEvent: string;
  occurrence?: number | undefined;
  reason?: string | undefined;
}

/**
 * The core adapter handle (sessionId is the shared native correlation UUID)
 * plus Claude-specific transcript extras.
 */
export interface ClaudeSession extends AgentAdapterBinding {
  /** Absolute path to this session's transcript JSONL (handed to us by hooks). */
  transcriptPath(): string | undefined;
  /** Force a transcript delta parse now (tests, explicit refresh). */
  pollTranscript(): Promise<void>;
}

export interface PrepareClaudeTuiSessionOptions extends Omit<CreateClaudeSessionOptions, 'ports'> {
  /** Route semantic automation to a terminal after the preparation is adopted. */
  automate(runtimeSessionId: string, operation: TerminalAutomationOperation): Promise<TerminalAutomationResult>;
}

/**
 * Bind to a Claude Code process that is ALREADY RUNNING in a host terminal —
 * the restart half of stable ingress. The process was launched against a hook
 * bridge on `ingress.port` with `ingress.token` (its settings and env carry
 * both), so a listener rebound on exactly that ingress receives the hooks,
 * status lines and telemetry it keeps posting; its durable transcript is found
 * by the session id under the config root and tailed from the start. Nothing
 * is launched; the terminal is adopted as-is.
 */
export interface AttachClaudeTuiSessionOptions extends Pick<
  CreateClaudeSessionOptions,
  | 'cwd'
  | 'env'
  | 'permissionMode'
  | 'model'
  | 'effort'
  | 'providerVersion'
  | 'configDir'
  | 'transcriptPollIntervalMs'
  | 'onDiagnostic'
  | 'hookBridgeFactory'
  | 'semanticProviderFactory'
  | 'observeOtlpUsage'
  | 'observeSubagentStatus'
> {
  /** The native session id the running process announced. */
  sessionId: string;
  /** The host's id for the terminal the process is running in. */
  runtimeSessionId: string;
  /** The ingress the process was launched against — rebound as-is. */
  ingress: BoundIngress;
  /** Route semantic automation to the adopted terminal. */
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
  // Sessions a native resume launch runs that are never the one resumed.
  const bootSessionIds = new Set<string>();
  const { otelUsageEnabled, otelUsageUnavailableReason, otelUsageVerified } = otelUsagePolicy(options);
  const bridge: HookBridge = (options.hookBridgeFactory ?? createHookBridge)({
    ...ingressPins(options.ingress),
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
      // Claude chooses the session after launch (`--resume` picker, `--continue`).
      // Until it announces the choice with the resumed session's SessionStart,
      // the process runs a throwaway boot session: 2.1.269 fires that session's
      // InstructionsLoaded (load_reason session_start) before the picker is
      // even shown, and a release may announce it with a `startup`
      // SessionStart (packages/surface/vendors/claude/findings.md §6). Neither
      // is ever the session observed here, so its hooks are acknowledged and
      // dropped rather than allowed to bind. Status lines rendered for the
      // highlighted conversation stay visible but claim nothing. The choice
      // may still move while only SessionStarts have arrived; the first hook
      // the announced session runs makes it final.
      const isHook = kind === 'hook';
      const isSessionStart = isHook && body.hook_event_name === 'SessionStart';
      if (!selectionLocked && isSessionStart && body.source !== 'startup') {
        bootSessionIds.delete(id);
        selectedSessionId = id;
        return true;
      }
      if (id === selectedSessionId) {
        if (isHook) selectionLocked = true;
        return true;
      }
      if (
        bootSessionIds.has(id) ||
        (!selectionLocked && (isSessionStart || (selectedSessionId === undefined && isHook)))
      ) {
        bootSessionIds.add(id);
        return 'ignore';
      }
      return selectedSessionId === undefined && !isHook;
    },
  });
  await bridge.start();

  try {
    reportBound(bridge, options.ingress);
    const prepared = await prepareClaudeSession({
      cwd: options.cwd,
      sessionId,
      resume: options.resume,
      resumeInvocation: options.resumeInvocation,
      title: options.title,
      executable: options.executable,
      env: options.env,
      permissionMode: options.permissionMode,
      model: options.model,
      effort: options.effort,
      settingSources: options.settingSources,
      configDir: options.configDir,
      fileChangeMatcher: options.fileChangeMatcher,
      endpoint: bridge.endpoint(),
      ...(otelUsageEnabled ? { otelLogsEndpoint: bridge.otelLogsEndpoint() } : {}),
      statusLineEndpoint: bridge.statusLineEndpoint(),
      ...(options.observeSubagentStatus === false
        ? {}
        : { subagentStatusLineEndpoint: bridge.subagentStatusLineEndpoint() }),
      tokenEnvVar: TOKEN_ENV_VAR,
      token: bridge.token,
    });

    try {
      const observation = createClaudeObservation(
        options,
        bridge,
        { sessionId: prepared.sessionId, cleanup: () => cleanupClaudeSession(prepared) },
        () => selectedSessionId ?? prepared.sessionId,
        otelUsageEnabled,
        otelUsageUnavailableReason,
        otelUsageVerified,
      );
      return {
        sessionId: prepared.sessionId,
        launch: prepared,
        adopt: observation.adopt,
        dispose: observation.dispose,
      };
    } catch (error) {
      await cleanupClaudeSession(prepared);
      throw error;
    }
  } catch (err) {
    await bridge.dispose();
    throw err;
  }
}

/** What the OTLP usage rail may do for this session, from the caller's option and the launch environment. */
function otelUsagePolicy(options: Pick<CreateClaudeSessionOptions, 'observeOtlpUsage' | 'providerVersion'>): {
  otelUsageEnabled: boolean;
  otelUsageUnavailableReason: string | undefined;
  otelUsageVerified: boolean;
} {
  const otelUsageUnavailableReason =
    options.observeOtlpUsage === false
      ? 'Authenticated OTLP request logs were disabled by the session option.'
      : !supportsClaudeOtelLogs(options.providerVersion)
        ? `Claude ${options.providerVersion} predates the locally verified OTLP log contract.`
        : hasClaudeOtelExporterConflict()
          ? 'Authenticated OTLP setup was disabled because the launching environment already owns exporter settings.'
          : undefined;
  return {
    otelUsageEnabled: otelUsageUnavailableReason === undefined,
    otelUsageUnavailableReason,
    otelUsageVerified: isClaudeOtelLogsVerified(options.providerVersion),
  };
}

/** The bridge options a host's ingress pins: only the keys it set (a fake bridge sees no `undefined`). */
function ingressPins(ingress: HostIngress | undefined): Pick<HookBridgeOptions, 'port' | 'token'> {
  return {
    ...(ingress?.port !== undefined && ingress.port !== 0 ? { port: ingress.port } : {}),
    ...(ingress?.token !== undefined ? { token: ingress.token } : {}),
  };
}

/** Tell the host what the bridge bound — port from the endpoint URL, the bearer as minted or pinned. */
function reportBound(bridge: HookBridge, ingress: HostIngress | undefined): void {
  if (!ingress?.onBound) return;
  let port: number;
  try {
    port = Number(new URL(bridge.endpoint()).port);
  } catch {
    return;
  }
  if (!Number.isInteger(port) || port <= 0) return;
  ingress.onBound({ port, token: bridge.token });
}

/** The identity an observation is bound to: the native session, and what to clean when it ends. */
interface ClaudeBoundIdentity {
  sessionId: string;
  cleanup(): Promise<void>;
}

/** A live bridge with its observation rails, adoptable by exactly one terminal. */
interface ClaudeObservation {
  adopt(runtimeSessionId: string): Promise<ClaudeSession>;
  dispose(): Promise<void>;
  /** Arm the durable transcript rail now rather than at the first hook (a re-attach knows the path already). */
  observeTranscript(path: string): void;
}

function createClaudeObservation(
  options: PrepareClaudeTuiSessionOptions & { attached?: boolean | undefined },
  bridge: HookBridge,
  bound: ClaudeBoundIdentity,
  nativeSessionId: () => string = () => bound.sessionId,
  otelUsageEnabled = false,
  otelUsageUnavailableReason?: string,
  otelUsageVerified = false,
): ClaudeObservation {
  const normalizer = new ClaudeHookNormalizer();
  const events = new ClaudeEventSource({ sessionId: nativeSessionId, providerVersion: options.providerVersion });
  let observation: ObservationLevel = 'terminal-only';
  let transcriptPath: string | undefined;
  const semanticProvider = options.semanticProviderFactory?.() ?? new ClaudeTranscriptObservationProvider();
  const semanticCapabilities = Promise.resolve().then(() => semanticProvider.capabilities());
  const monitorEvidence = new ClaudeMonitorEvidence({
    nativeSessionId,
    otelUsageEnabled,
    otelUsageUnavailableReason,
    otelUsageVerified,
  });
  let semanticHandle: SemanticObservationHandle | undefined;
  let semanticAttachment: Promise<SemanticObservationHandle | undefined> | undefined;
  let semanticGeneration = 0;
  let adoptedRuntimeSessionId: string | undefined;
  let adoptedSession: ClaudeSession | undefined;
  let disposed = false;
  // A transcript known before anyone listens (a re-attach) is armed at the
  // first subscription, like configured intent and capabilities: the event
  // source buffers early candidates, so nothing is lost by waiting — the wait
  // ORDERS the baseline read after the intent and capability batches.
  let pendingTranscript: string | undefined;
  let subscribed = false;
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
  const observedOtelUsage = new Map<string, string>();
  const observedOtelModels = new Map<string, string>();
  const observedOtelWorkflows = new Map<string, string>();

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
      { type: 'monitor:batch', batch },
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

  function apply(event: AgentEvent, meta: ClaudeEventPublication): void {
    // Settled request usage belongs exclusively to authenticated API telemetry.
    if (event.type === 'usage:tokens-used' && meta.source !== 'native-telemetry') return;
    // Injector wiring rides the normalized stream, not raw payloads.
    switch (event.type) {
      case 'turn:started':
        injector.handleTurnStarted(event.turnId, event.prompt);
        break;
      case 'interaction:permission-requested':
        pendingPermissionIds.add(event.requestId);
        injector.setPermissionPending(pendingPermissionIds.size > 0);
        break;
      case 'interaction:permission-resolved':
        pendingPermissionIds.delete(event.requestId);
        injector.setPermissionPending(pendingPermissionIds.size > 0);
        break;
      case 'interaction:question-requested':
        pendingQuestionIds.add(event.requestId);
        injector.setQuestionPending(pendingQuestionIds.size > 0);
        break;
      case 'interaction:question-resolved':
        pendingQuestionIds.delete(event.requestId);
        injector.setQuestionPending(pendingQuestionIds.size > 0);
        break;
      case 'session:started':
        if (!event.rebind) break;
        pendingPermissionIds.clear();
        pendingQuestionIds.clear();
        injector.setPermissionPending(false);
        injector.setQuestionPending(false);
        break;
      // A native boundary is authoritative even if an older Claude release
      // omitted a resolution signal for one request.
      case 'turn:completed':
      case 'turn:failed':
      case 'session:exited':
        pendingPermissionIds.clear();
        pendingQuestionIds.clear();
        injector.setPermissionPending(false);
        injector.setQuestionPending(false);
        break;
    }

    events.publish(event, meta);
  }

  function publishConfiguredIntent(): void {
    if (configuredIntentPublished) return;
    configuredIntentPublished = true;
    const publication = {
      source: 'runtime' as const,
      timestamp: new Date().toISOString(),
      providerVersion: options.providerVersion,
    };
    if (options.model) {
      apply(
        { type: 'model:updated', intent: 'configured', model: { id: options.model, provider: 'anthropic' } },
        publication,
      );
    }
    if (options.effort) {
      apply({ type: 'effort:updated', intent: 'configured', effort: options.effort }, publication);
    }
    apply(
      {
        type: 'mode:updated',
        intent: 'configured',
        modeKind: 'provider-permission',
        mode: claudePermissionMode(options.permissionMode ?? 'default'),
      },
      publication,
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
      { type: 'adapter:native-event', adapter: 'claude-code', nativeType: 'hook-bridge.unavailable' },
      {
        source: 'runtime',
        timestamp: observedAt,
        providerVersion: options.providerVersion,
        native: { reason },
      },
    );
  };

  bridge.onUnavailable(reportHookRailUnavailable);

  bridge.onOtelLogs((otelEnvelope) => {
    if (!otelUsageEnabled || disposed) return;
    for (const record of decodeClaudeOtelLogs(otelEnvelope.body, otelEnvelope.receivedAt)) {
      if (otelString(record, 'session.id') !== nativeSessionId()) continue;

      const usage = normalizeClaudeOtelUsage(record);
      const model = normalizeClaudeOtelModel(record);
      const workflow = normalizeClaudeOtelWorkflow(record);
      if (!usage && !model && !workflow) {
        apply(
          {
            type: 'adapter:native-event',
            adapter: 'claude-code',
            nativeType: `otel:${otelString(record, 'event.name') ?? record.body ?? 'log'}`,
          },
          {
            source: 'native-telemetry',
            timestamp: record.timestamp,
            promptId: otelString(record, 'prompt.id'),
            providerVersion: record.providerVersion ?? options.providerVersion,
            confidence: 'authoritative',
            native: record,
          },
        );
        if (observation === 'terminal-only') observation = 'native-log';
        continue;
      }
      if (observation === 'terminal-only') observation = 'native-log';

      if (usage) {
        const key = usage.event.usageId;
        const fingerprint = JSON.stringify([
          usage.event,
          usage.agentId ?? null,
          usage.agentType ?? null,
          usage.actorKey ?? null,
          usage.actorRole ?? null,
        ]);
        const previous = observedOtelUsage.get(key);
        rememberFingerprint(observedOtelUsage, key, fingerprint, MAX_OTEL_USAGE_FINGERPRINTS);
        if (previous !== fingerprint) {
          apply(usage.event, {
            source: 'native-telemetry',
            timestamp: usage.timestamp,
            promptId: usage.promptId,
            agentId: usage.agentId,
            agentType: usage.agentType,
            actorKey: usage.actorKey,
            actorRole: usage.actorRole,
            providerVersion: usage.providerVersion ?? options.providerVersion,
            confidence: 'authoritative',
            native: usage.nativeEvent,
          });
        }
      }

      if (model) {
        const key = model.agentId ?? model.actorKey ?? 'root';
        const fingerprint = JSON.stringify(model.event);
        if (observedOtelModels.get(key) !== fingerprint) {
          rememberFingerprint(observedOtelModels, key, fingerprint, MAX_OTEL_ACTOR_FINGERPRINTS);
          apply(model.event, {
            source: 'native-telemetry',
            timestamp: model.timestamp,
            promptId: otelString(record, 'prompt.id'),
            agentId: model.agentId,
            agentType: model.agentType,
            actorKey: model.actorKey,
            actorRole: model.actorRole,
            providerVersion: record.providerVersion ?? options.providerVersion,
            confidence: 'authoritative',
            native: record,
          });
        }
      }

      if (workflow) {
        const fingerprint = JSON.stringify(workflow.event);
        if (observedOtelWorkflows.get(workflow.event.workflowId) !== fingerprint) {
          rememberFingerprint(
            observedOtelWorkflows,
            workflow.event.workflowId,
            fingerprint,
            MAX_OTEL_WORKFLOW_FINGERPRINTS,
          );
          apply(workflow.event, {
            source: 'native-telemetry',
            timestamp: workflow.timestamp,
            promptId: otelString(record, 'prompt.id'),
            providerVersion: record.providerVersion ?? options.providerVersion,
            confidence: 'authoritative',
            native: record,
          });
        }
      }
    }
  });

  function ensureSemanticProvider(path: string): void {
    if (semanticAttachment && transcriptPath === path) return;
    semanticGeneration += 1;
    const generation = semanticGeneration;
    const priorAttachment = semanticAttachment;
    transcriptPath = path;
    const nextAttachment = (async (): Promise<SemanticObservationHandle | undefined> => {
      const prior = await priorAttachment?.catch(() => undefined);
      await prior?.dispose();
      await semanticCapabilities;
      if (disposed || generation !== semanticGeneration) return undefined;
      const handle = await semanticProvider.attach({
        nativeSessionId: nativeSessionId(),
        transcriptPath: path,
        pollIntervalMs: options.transcriptPollIntervalMs,
      });
      if (disposed || generation !== semanticGeneration) {
        await handle.dispose();
        return undefined;
      }
      semanticHandle = handle;
      // A tailed transcript is native-log observation. Hooks upgrade it; they
      // never come first for a re-attached session, which announces nothing.
      if (observation === 'terminal-only') observation = 'native-log';
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
        emitMonitorBatch(batch);
      });
      handle.onError((error) => {
        if (disposed || generation !== semanticGeneration) return;
        apply(
          { type: 'adapter:native-event', adapter: 'claude-code', nativeType: 'semantic-observer.error' },
          {
            source: 'runtime',
            timestamp: new Date().toISOString(),
            native: {
              name: error.name,
              code:
                typeof (error as Error & { code?: unknown }).code === 'string'
                  ? (error as Error & { code: string }).code
                  : 'unknown',
            },
          },
        );
        // The semantic rail publishes its own degraded batch; hooks and the TUI continue.
      });
      try {
        await handle.poll();
      } catch (error) {
        if (semanticHandle === handle) semanticHandle = undefined;
        await handle.dispose();
        throw error;
      }
      return handle;
    })().catch((error: unknown) => {
      if (!disposed && generation === semanticGeneration) {
        if (semanticAttachment === nextAttachment) semanticAttachment = undefined;
        apply(
          { type: 'adapter:native-event', adapter: 'claude-code', nativeType: 'semantic-observer.unavailable' },
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
    // The bridge admits only the selected session's hooks, so the first
    // transcript path to arrive is that session's durable history — on a
    // native resume, the path its SessionStart announces.
    if (normalized.transcriptPath) ensureSemanticProvider(normalized.transcriptPath);
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
      if (event.type === 'context-window:invalidated') {
        emitMonitorBatch(monitorEvidence.rootContextInvalidationBatch(hookEnvelope.receivedAt, hookEnvelope.requestId));
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

    const environmentEvents = claudeEnvironmentEvents(statusEnvelope.body);
    if (environmentEvents.length > 0) {
      const environmentKey = JSON.stringify(environmentEvents);
      if (environmentKey !== observedStatusEnvironmentKey) {
        observedStatusEnvironmentKey = environmentKey;
        for (const event of environmentEvents) {
          apply(event, {
            source: 'native-statusline',
            timestamp: statusEnvelope.receivedAt,
            providerVersion: payloadVersion(statusEnvelope.body),
            native: statusEnvelope.body,
          });
        }
      }
    }

    const contextEvent = claudeContextWindowEvent(statusEnvelope.body);
    if (!contextEvent) return;
    if (contextEvent.type === 'context-window:invalidated') {
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

  async function dispose(disposeOptions?: AdapterDisposeOptions): Promise<void> {
    if (disposed) return;
    disposed = true;
    events.close();
    const attached = await semanticAttachment?.catch(() => undefined);
    await attached?.dispose();
    if (disposeOptions?.release) {
      // The host leaves, the process stays: the bridge drains rather than
      // resets, and the staged settings and forwarders the process execs on
      // every hook are NOT removed — a host that comes back rebinds the same
      // port and the hooks keep landing.
      await bridge.dispose({ drain: true });
      return;
    }
    await bridge.dispose();
    await bound.cleanup();
  }

  return {
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
        events: {
          onCandidate(listener) {
            const unsubscribe = events.onCandidate(listener);
            subscribed = true;
            // configured intent is a LAUNCH fact (the model, effort and mode
            // this host asked for); an attached process was asked by someone
            // else, and its next hook or status line says what it is
            if (!options.attached) publishConfiguredIntent();
            void publishCapabilities();
            if (pendingTranscript !== undefined) {
              const path = pendingTranscript;
              pendingTranscript = undefined;
              ensureSemanticProvider(path);
            }
            return unsubscribe;
          },
        },
        services: {
          prompt: { submit: (submission) => injector.submit(submission) },
          artifacts: createClaudeArtifactService(() => semanticAttachment),
        },
        pollTranscript: async () => {
          const handle = await semanticAttachment;
          await handle?.poll();
        },
        dispose,
      };
      return adoptedSession;
    },
    dispose,
    observeTranscript: (path) => {
      if (disposed) return;
      if (subscribed) ensureSemanticProvider(path);
      else pendingTranscript = path;
    },
  };
}

/**
 * Bind to a running Claude Code process (see {@link AttachClaudeTuiSessionOptions}).
 * Fails — before anything is adopted — when the pinned port cannot be bound:
 * the host then knows the ingress is lost and resumes the continuation instead.
 */
export async function attachClaudeTuiSession(options: AttachClaudeTuiSessionOptions): Promise<ClaudeSession> {
  if (!Number.isInteger(options.ingress.port) || options.ingress.port <= 0 || options.ingress.token.length === 0) {
    throw new Error('Claude attach needs the ingress the process was launched against (a positive port and a token)');
  }
  const { otelUsageEnabled, otelUsageUnavailableReason, otelUsageVerified } = otelUsagePolicy(options);
  const configDir = (options.configDir ?? options.env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR)?.trim();
  const root =
    options.env?.PUPPETEER_IMPOSTER_HOME ?? (configDir ? resolve(options.cwd, configDir) : join(homedir(), '.claude'));
  let selectedSessionId = options.sessionId;
  let heardPinned = false;
  let observation: ClaudeObservation | undefined;
  const bridge: HookBridge = (options.hookBridgeFactory ?? createHookBridge)({
    port: options.ingress.port,
    token: options.ingress.token,
    allowSession: (id, kind, body) => {
      if (id === selectedSessionId) {
        if (kind === 'hook') heardPinned = true;
        return true;
      }
      // `/clear` rotates the native identity in-process; the attached session
      // follows it exactly as a spawned one does.
      if (kind === 'hook' && body.hook_event_name === 'SessionStart' && body.source === 'clear') {
        selectedSessionId = id;
        heardPinned = true;
        return true;
      }
      // A `/clear` typed while no host was listening rotated the id unheard.
      // The first authenticated hook under a new id — before the selected id
      // has spoken since the attach — is that rotation, when the new id
      // already has a transcript under the same root (a subagent's or a
      // stranger's id has none there). Once heard, the selection is final
      // until the next in-process `/clear`.
      if (kind === 'hook' && !heardPinned) {
        const rotated = locateClaudeTranscript(id, root);
        if (rotated !== undefined) {
          selectedSessionId = id;
          heardPinned = true;
          observation?.observeTranscript(rotated);
          return true;
        }
      }
      return false;
    },
  });
  await bridge.start();
  try {
    observation = createClaudeObservation(
      { ...options, ingress: undefined, attached: true },
      bridge,
      { sessionId: options.sessionId, cleanup: async () => undefined },
      () => selectedSessionId,
      otelUsageEnabled,
      otelUsageUnavailableReason,
      otelUsageVerified,
    );
    // The durable rail first: a quiet session announces nothing until its next
    // hook, and its transcript already says where it stands.
    const transcript = locateClaudeTranscript(options.sessionId, root);
    if (transcript !== undefined) observation.observeTranscript(transcript);
    return await observation.adopt(options.runtimeSessionId);
  } catch (err) {
    await bridge.dispose();
    throw err;
  }
}

export async function createClaudeSession(options: CreateClaudeSessionOptions): Promise<ClaudeSession> {
  const prepared = await prepareClaudeTuiSession({
    cwd: options.cwd,
    title: options.title,
    executable: options.executable,
    env: options.env,
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
    ingress: options.ingress,
    hookBridgeFactory: options.hookBridgeFactory,
    hookRailFaultInjection: options.hookRailFaultInjection,
    semanticProviderFactory: options.semanticProviderFactory,
    observeOtlpUsage: options.observeOtlpUsage,
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
