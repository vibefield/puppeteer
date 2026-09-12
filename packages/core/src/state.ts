/**
 * Session state reducer (DESIGN §15).
 *
 * All normalized events pass through this deterministic, pure reducer:
 * - never throws on duplicate, out-of-order, or unknown events
 * - duplicates (sequence <= lastSequence) are skipped by returning the SAME
 *   state reference, so replays are idempotent
 * - invalid transitions produce bounded diagnostics, never exceptions
 * - the raw event log is retained upstream (envelopes are append-only);
 *   state is always rebuildable by replay
 *
 * Terminal geometry and control-lease state (DESIGN §15's `terminal`/`control`
 * fields) are owned by the node runtime, not this reducer — they derive from
 * PTY and lease facts, not agent events.
 */

import type {
  AgentEvent,
  AgentEventConfidence,
  AgentEventEnvelope,
  AgentEventSource,
  AgentGitState,
  AgentModelIdentity,
  ProcessExitReason,
  ToolPresentation,
} from './events/index.js';

export type SessionLifecycle =
  'preparing' | 'starting' | 'ready' | 'running' | 'interrupting' | 'terminating' | 'exited' | 'failed';

export interface ToolRuntimeState {
  toolCallId: string;
  tool?: string | undefined;
  state: 'requested' | 'running';
  input?: unknown;
  presentation?: ToolPresentation | undefined;
}

export interface ReasoningRuntimeState {
  reasoningId?: string | undefined;
  startedAt: string;
}

export interface PermissionRuntimeState {
  requestId: string;
  toolCallId?: string | undefined;
  tool?: string | undefined;
}

export interface SubagentRuntimeState {
  subagentId: string;
  agentType?: string | undefined;
}

export interface ReducerDiagnostic {
  sequence: number;
  code: string;
  message: string;
}

/** Latest trustworthy context-window measurement for this agent session. */
export interface ContextWindowRuntimeState {
  usedTokens: number;
  capacityTokens: number;
  /** Exact, unrounded percentage in the inclusive range 0..100. */
  usedPercent: number;
  percentageSource?: 'provider' | 'derived' | undefined;
  modelId?: string | undefined;
  updatedAt: string;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
}

export interface ObservedEnvironmentValue<T> {
  value: T;
  updatedAt: string;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
}

export interface SessionEnvironmentRuntimeState {
  currentCwd?: ObservedEnvironmentValue<string> | undefined;
  model?: ObservedEnvironmentValue<AgentModelIdentity> | undefined;
  /** A null value authoritatively means the current cwd is not in a Git repo. */
  git?: ObservedEnvironmentValue<AgentGitState | null> | undefined;
}

export interface SessionRuntimeState {
  lifecycle: SessionLifecycle;
  activeTurn?: { id?: string | undefined; startedAt: string } | undefined;
  /** Present only for providers with an explicit reasoning signal. */
  activeReasoning?: ReasoningRuntimeState | undefined;
  /** Tools currently in flight. Completed/failed tools LEAVE this map. */
  tools: Map<string, ToolRuntimeState>;
  /**
   * Bounded terminal-id memory used to make native duplicate and out-of-order
   * tool events idempotent. Provider item ids are session-unique; retaining a
   * tombstone prevents a late `tool:started` from reviving a completed call.
   */
  settledTools: Map<string, 'completed' | 'failed'>;
  /** Pending permission requests. Resolved requests leave this map. */
  permissions: Map<string, PermissionRuntimeState>;
  subagents: Map<string, SubagentRuntimeState>;
  /** Absent until measured, and while invalidated after compaction/history changes. */
  contextWindow?: ContextWindowRuntimeState | undefined;
  /** Live provider/runtime facts about where and how the agent is executing. */
  environment: SessionEnvironmentRuntimeState;
  lastAssistantMessage?: string | undefined;
  exit?:
    | { exitCode?: number | undefined; signal?: string | undefined; reason?: ProcessExitReason | string | undefined }
    | undefined;
  counters: {
    toolsCompleted: number;
    toolsFailed: number;
    unknownEvents: number;
  };
  lastSequence: number;
  diagnostics: ReducerDiagnostic[];
}

const MAX_DIAGNOSTICS = 50;
const MAX_SETTLED_TOOLS = 1024;

export function createInitialSessionState(): SessionRuntimeState {
  return {
    lifecycle: 'preparing',
    tools: new Map(),
    settledTools: new Map(),
    permissions: new Map(),
    subagents: new Map(),
    environment: {},
    counters: { toolsCompleted: 0, toolsFailed: 0, unknownEvents: 0 },
    lastSequence: 0,
    diagnostics: [],
  };
}

function withDiagnostic(
  state: SessionRuntimeState,
  sequence: number,
  code: string,
  message: string,
): SessionRuntimeState {
  if (state.diagnostics.length >= MAX_DIAGNOSTICS) return state;
  return { ...state, diagnostics: [...state.diagnostics, { sequence, code, message }] };
}

function isTerminal(lifecycle: SessionLifecycle): boolean {
  return lifecycle === 'exited' || lifecycle === 'failed';
}

function rejectResourceAfterExit(
  state: SessionRuntimeState,
  sequence: number,
  eventType: string,
): SessionRuntimeState | undefined {
  if (!isTerminal(state.lifecycle)) return undefined;
  return withDiagnostic(state, sequence, 'resource-after-exit', `${eventType} in ${state.lifecycle}`);
}

function rememberSettledTool(
  settledTools: ReadonlyMap<string, 'completed' | 'failed'>,
  toolCallId: string,
  outcome: 'completed' | 'failed',
): Map<string, 'completed' | 'failed'> {
  const next = new Map(settledTools);
  next.set(toolCallId, outcome);
  while (next.size > MAX_SETTLED_TOOLS) {
    const oldest = next.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

function diagnoseOrphansOnExit(state: SessionRuntimeState, sequence: number): SessionRuntimeState {
  let next = state;
  if (next.activeTurn) {
    next = withDiagnostic(
      next,
      sequence,
      'turn-orphaned-on-exit',
      `session exited with turn ${next.activeTurn.id ?? '?'} active`,
    );
  }
  if (next.activeReasoning) {
    next = withDiagnostic(
      next,
      sequence,
      'reasoning-orphaned-on-exit',
      `session exited with reasoning ${next.activeReasoning.reasoningId ?? '?'} active`,
    );
  }
  const collections: Array<[{ size: number }, string, string]> = [
    [next.tools, 'tools', 'tool(s) in flight'],
    [next.permissions, 'permissions', 'permission request(s) pending'],
    [next.subagents, 'subagents', 'subagent(s) active'],
  ];
  for (const [collection, code, label] of collections) {
    if (collection.size > 0) {
      next = withDiagnostic(
        next,
        sequence,
        `${code}-orphaned-on-exit`,
        `session exited with ${collection.size} ${label}`,
      );
    }
  }
  return next;
}

export function reduceSessionState(state: SessionRuntimeState, envelope: AgentEventEnvelope): SessionRuntimeState {
  // Duplicate / out-of-order guard: envelopes are stamped in ingestion order,
  // so a non-increasing sequence is a replayed or stale event. Returning the
  // same reference keeps replays idempotent.
  if (envelope.sequence <= state.lastSequence) return state;

  let next: SessionRuntimeState = { ...state, lastSequence: envelope.sequence };
  const event = envelope.event as AgentEvent;
  const seq = envelope.sequence;

  // This detailed state machine models the root conversation only.
  // Actor-local evidence remains available on the event and monitor rails;
  // delegation events are the explicit root-facing relationship records.
  if ((envelope.agentId || envelope.actorKey) && !event.type.startsWith('delegation:')) return next;

  switch (event.type) {
    case 'process:started': {
      if (next.lifecycle === 'preparing') next = { ...next, lifecycle: 'starting' };
      else next = withDiagnostic(next, seq, 'process-started-late', `process:started in ${next.lifecycle}`);
      break;
    }

    case 'session:started': {
      if (event.rebind) {
        next = {
          ...next,
          lifecycle: 'ready',
          activeTurn: undefined,
          activeReasoning: undefined,
          tools: new Map(),
          settledTools: new Map(),
          permissions: new Map(),
          subagents: new Map(),
          contextWindow: undefined,
          exit: undefined,
        };
      } else if (isTerminal(next.lifecycle)) {
        next = withDiagnostic(next, seq, 'session-start-after-exit', `${event.type} in ${next.lifecycle}`);
      } else if (next.lifecycle !== 'running') {
        next = { ...next, lifecycle: 'ready' };
      }
      break;
    }

    case 'session:ready': {
      if (isTerminal(next.lifecycle)) {
        next = withDiagnostic(next, seq, 'session-start-after-exit', `${event.type} in ${next.lifecycle}`);
      } else if (next.lifecycle !== 'running') {
        next = { ...next, lifecycle: 'ready' };
      }
      break;
    }

    case 'turn:started': {
      if (isTerminal(next.lifecycle)) {
        next = withDiagnostic(next, seq, 'turn-after-exit', `turn:started in ${next.lifecycle}`);
        break;
      }
      if (next.activeTurn) {
        next = withDiagnostic(next, seq, 'turn-overlap', `turn:started while turn ${next.activeTurn.id ?? '?'} active`);
      }
      next = { ...next, lifecycle: 'running', activeTurn: { id: event.turnId, startedAt: envelope.timestamp } };
      break;
    }

    case 'turn:completed':
    case 'turn:failed': {
      if (next.activeTurn && event.turnId && next.activeTurn.id && next.activeTurn.id !== event.turnId) {
        next = withDiagnostic(
          next,
          seq,
          'turn-mismatch',
          `${event.type} for ${event.turnId}, active is ${next.activeTurn.id}`,
        );
      }
      next = { ...next, activeTurn: undefined, activeReasoning: undefined };
      if (!isTerminal(next.lifecycle)) next = { ...next, lifecycle: 'ready' };
      if (event.type === 'turn:completed' && event.lastAssistantMessage !== undefined) {
        next = { ...next, lastAssistantMessage: event.lastAssistantMessage };
      }
      break;
    }

    case 'conversation:assistant-message': {
      if (event.final !== false) next = { ...next, lastAssistantMessage: event.text };
      break;
    }

    case 'context-window:updated': {
      if (envelope.agentId || envelope.actorKey) break;
      if (
        !Number.isFinite(event.usedTokens) ||
        event.usedTokens < 0 ||
        !Number.isFinite(event.capacityTokens) ||
        event.capacityTokens <= 0
      ) {
        next = withDiagnostic(
          next,
          seq,
          'context-window-invalid',
          `invalid context window ${event.usedTokens}/${event.capacityTokens}`,
        );
        break;
      }
      const validUsedPercentage =
        event.usedPercentage !== undefined &&
        Number.isFinite(event.usedPercentage) &&
        event.usedPercentage >= 0 &&
        event.usedPercentage <= 100;
      next = {
        ...next,
        contextWindow: {
          usedTokens: event.usedTokens,
          capacityTokens: event.capacityTokens,
          usedPercent: validUsedPercentage
            ? event.usedPercentage!
            : Math.min(100, Math.max(0, (event.usedTokens / event.capacityTokens) * 100)),
          ...(event.usedPercentage !== undefined || event.percentageSource !== undefined
            ? {
                percentageSource: validUsedPercentage ? (event.percentageSource ?? 'provider') : 'derived',
              }
            : {}),
          modelId: event.modelId,
          updatedAt: envelope.timestamp,
          source: envelope.source,
          confidence: envelope.confidence,
        },
      };
      break;
    }

    case 'context-window:invalidated':
      if (envelope.agentId || envelope.actorKey) break;
      next = { ...next, contextWindow: undefined };
      break;

    case 'environment:updated': {
      if (envelope.agentId || envelope.actorKey) break;
      let environment = next.environment;
      const observed = <T>(value: T): ObservedEnvironmentValue<T> => ({
        value,
        updatedAt: envelope.timestamp,
        source: envelope.source,
        confidence: envelope.confidence,
      });

      if (event.currentCwd !== undefined) {
        if (event.currentCwd === null) {
          environment = { ...environment, currentCwd: undefined, git: undefined };
        } else if (!event.currentCwd.trim()) {
          next = withDiagnostic(next, seq, 'environment-cwd-invalid', 'current cwd must be non-empty');
        } else {
          const cwd = event.currentCwd.trim();
          const changed = environment.currentCwd?.value !== cwd;
          environment = { ...environment, currentCwd: observed(cwd), ...(changed ? { git: undefined } : {}) };
        }
      }

      if (event.git !== undefined) {
        if (event.git !== null && !event.git.root.trim()) {
          next = withDiagnostic(next, seq, 'environment-git-invalid', 'Git root must be non-empty');
        } else {
          environment = { ...environment, git: observed(event.git) };
        }
      }

      if (environment !== next.environment) next = { ...next, environment };
      break;
    }

    case 'model:updated': {
      if (envelope.agentId || envelope.actorKey || event.intent === 'configured') break;
      let environment = next.environment;
      const observed = <T>(value: T): ObservedEnvironmentValue<T> => ({
        value,
        updatedAt: envelope.timestamp,
        source: envelope.source,
        confidence: envelope.confidence,
      });
      if (event.model === null) {
        environment = { ...environment, model: undefined };
      } else if (!event.model.id.trim()) {
        next = withDiagnostic(next, seq, 'model-id-invalid', 'model id must be non-empty');
      } else {
        const id = event.model.id.trim();
        const previous = environment.model?.value.id === id ? environment.model.value : undefined;
        environment = { ...environment, model: observed({ ...previous, ...event.model, id }) };
      }
      if (environment !== next.environment) next = { ...next, environment };
      break;
    }

    case 'effort:updated':
    case 'mode:updated':
      // These domains are exposed through the monitor projection. Session
      // state intentionally retains only filesystem and effective model facts.
      break;

    case 'reasoning:started': {
      const rejected = rejectResourceAfterExit(next, seq, event.type);
      if (rejected) {
        next = rejected;
        break;
      }
      next = {
        ...next,
        activeReasoning: { reasoningId: event.reasoningId, startedAt: envelope.timestamp },
      };
      break;
    }

    case 'reasoning:progress':
    case 'reasoning:summary': {
      const rejected = rejectResourceAfterExit(next, seq, event.type);
      if (rejected) {
        next = rejected;
        break;
      }
      if (!next.activeReasoning) {
        next = {
          ...next,
          activeReasoning: { reasoningId: event.reasoningId, startedAt: envelope.timestamp },
        };
      }
      break;
    }

    case 'reasoning:completed':
      next = { ...next, activeReasoning: undefined };
      break;

    case 'tool:requested': {
      const rejected = rejectResourceAfterExit(next, seq, event.type);
      if (rejected) {
        next = rejected;
        break;
      }
      const terminal = next.settledTools.get(event.toolCallId);
      if (terminal) {
        next = withDiagnostic(
          next,
          seq,
          'tool-after-terminal',
          `${event.type} for already ${terminal} tool ${event.toolCallId}`,
        );
        break;
      }
      const tools = new Map(next.tools);
      tools.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        tool: event.tool,
        state: 'requested',
        input: event.input,
        presentation: event.presentation,
      });
      next = { ...next, tools };
      break;
    }

    case 'tool:started': {
      const rejected = rejectResourceAfterExit(next, seq, event.type);
      if (rejected) {
        next = rejected;
        break;
      }
      const terminal = next.settledTools.get(event.toolCallId);
      if (terminal) {
        next = withDiagnostic(
          next,
          seq,
          'tool-after-terminal',
          `${event.type} for already ${terminal} tool ${event.toolCallId}`,
        );
        break;
      }
      const existing = next.tools.get(event.toolCallId);
      const tools = new Map(next.tools);
      tools.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        tool: event.tool ?? existing?.tool,
        state: 'running',
        input: event.input ?? existing?.input,
        presentation: event.presentation ?? existing?.presentation,
      });
      next = { ...next, tools };
      break;
    }

    case 'tool:completed':
    case 'tool:failed': {
      const outcome = event.type === 'tool:completed' ? 'completed' : 'failed';
      const previous = next.settledTools.get(event.toolCallId);
      if (previous) {
        if (previous !== outcome) {
          next = withDiagnostic(
            next,
            seq,
            'tool-terminal-conflict',
            `${event.type} for already ${previous} tool ${event.toolCallId}`,
          );
        }
        break;
      }
      // Absent ids are not diagnostics: hook and transcript sources may both
      // report a terminal event, and native protocols can deliver completion
      // before start. The tombstone makes later duplicates and starts inert.
      const tools = new Map(next.tools);
      if (next.tools.has(event.toolCallId)) {
        tools.delete(event.toolCallId);
      }
      const counters = { ...next.counters };
      if (event.type === 'tool:completed') counters.toolsCompleted += 1;
      else counters.toolsFailed += 1;
      next = {
        ...next,
        tools,
        settledTools: rememberSettledTool(next.settledTools, event.toolCallId, outcome),
        counters,
      };
      break;
    }

    case 'interaction:permission-requested': {
      const rejected = rejectResourceAfterExit(next, seq, event.type);
      if (rejected) {
        next = rejected;
        break;
      }
      // Permission state is intentionally isolated from tool state (DESIGN §26.5).
      const permissions = new Map(next.permissions);
      permissions.set(event.requestId, { requestId: event.requestId, toolCallId: event.toolCallId, tool: event.tool });
      next = { ...next, permissions };
      break;
    }

    case 'interaction:permission-resolved': {
      if (next.permissions.has(event.requestId)) {
        const permissions = new Map(next.permissions);
        permissions.delete(event.requestId);
        next = { ...next, permissions };
      }
      break;
    }

    case 'delegation:subagent-started': {
      const rejected = rejectResourceAfterExit(next, seq, event.type);
      if (rejected) {
        next = rejected;
        break;
      }
      const subagents = new Map(next.subagents);
      subagents.set(event.subagentId, { subagentId: event.subagentId, agentType: event.agentType });
      next = { ...next, subagents };
      break;
    }

    case 'delegation:subagent-stopped': {
      if (next.subagents.has(event.subagentId)) {
        const subagents = new Map(next.subagents);
        subagents.delete(event.subagentId);
        next = { ...next, subagents };
      }
      break;
    }

    case 'session:exited': {
      next = diagnoseOrphansOnExit(next, seq);
      next = {
        ...next,
        lifecycle: 'exited',
        activeTurn: undefined,
        activeReasoning: undefined,
        tools: new Map(),
        permissions: new Map(),
        subagents: new Map(),
        exit: next.exit ?? { reason: event.reason },
      };
      break;
    }

    case 'process:exited': {
      const failed = event.reason === 'crash' || event.reason === 'spawn-failed' || event.reason === 'workspace-failed';
      next = diagnoseOrphansOnExit(next, seq);
      next = {
        ...next,
        lifecycle: isTerminal(next.lifecycle) ? next.lifecycle : failed ? 'failed' : 'exited',
        activeTurn: undefined,
        activeReasoning: undefined,
        tools: new Map(),
        permissions: new Map(),
        subagents: new Map(),
        exit: { exitCode: event.exitCode, signal: event.signal, reason: event.reason },
      };
      break;
    }

    case 'workspace:file-operation':
    case 'workspace:file-changed':
    case 'notification:received':
    case 'usage:tokens-used':
    case 'workflow:updated':
    case 'compaction:started':
    case 'compaction:completed':
    case 'delegation:teammate-idle':
    case 'interaction:question-requested':
    case 'interaction:question-resolved':
      break;

    case 'adapter:native-event': {
      next = { ...next, counters: { ...next.counters, unknownEvents: next.counters.unknownEvents + 1 } };
      if (event.diagnostic) {
        next = withDiagnostic(next, seq, event.diagnostic.code, event.diagnostic.message);
      }
      break;
    }

    default: {
      // Unknown event types must never throw (DESIGN §15.2).
      next = { ...next, counters: { ...next.counters, unknownEvents: next.counters.unknownEvents + 1 } };
      break;
    }
  }

  return next;
}
