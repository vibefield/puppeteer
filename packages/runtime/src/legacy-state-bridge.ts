import type {
  ContextWindowRuntimeState,
  SessionEnvironmentRuntimeState,
  SessionRuntimeState,
  ToolPresentation,
} from '@vibecook/puppeteer-core';

/**
 * JSON-plain v1 renderer contract retained for the one-release rollback path.
 * New renderer code must consume AgentMonitorState instead.
 */
export interface LegacySerializedSessionState {
  lifecycle: string;
  activeTurn?: { id?: string; startedAt: string };
  activeReasoning?: { reasoningId?: string; startedAt: string };
  tools: {
    toolCallId: string;
    tool?: string;
    state: 'requested' | 'running';
    input?: unknown;
    presentation?: ToolPresentation;
  }[];
  permissions: { requestId: string; toolCallId?: string; tool?: string }[];
  subagents: { subagentId: string; agentType?: string }[];
  tasks: { taskId: string; description?: string }[];
  contextWindow?: ContextWindowRuntimeState;
  environment: SessionEnvironmentRuntimeState;
  lastAssistantMessage?: string;
  exit?: { exitCode?: number; signal?: string; reason?: string };
  counters: { toolsCompleted: number; toolsFailed: number; unknownEvents: number };
  lastSequence: number;
  diagnostics: { sequence: number; code: string; message: string }[];
}

/** Isolated compatibility conversion for godviewMonitorV2=false. */
export function serializeLegacySessionState(state: SessionRuntimeState): LegacySerializedSessionState {
  return {
    lifecycle: state.lifecycle,
    activeTurn: state.activeTurn,
    activeReasoning: state.activeReasoning,
    tools: [...state.tools.values()],
    permissions: [...state.permissions.values()],
    subagents: [...state.subagents.values()],
    tasks: [...state.tasks.values()],
    contextWindow: state.contextWindow,
    environment: state.environment,
    lastAssistantMessage: state.lastAssistantMessage,
    exit: state.exit,
    counters: state.counters,
    lastSequence: state.lastSequence,
    diagnostics: state.diagnostics,
  };
}
