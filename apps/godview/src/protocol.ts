import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type {
  AccountUsageFailure,
  AccountUsageFetchResult,
  MonitorArtifactReadResult,
  ObservationLevel,
  PromptReceipt as CorePromptReceipt,
} from '@vibecook/puppeteer-core';
import type {
  AgentSessionFailure as RuntimeAgentSessionFailure,
  AgentSessionInfo as RuntimeAgentSessionInfo,
  AgentWorkspaceFinal,
  AgentWorkspaceInfo,
  AcknowledgeAgentFailureRequest,
  AgentMonitorNotificationMessage,
  AgentMonitorRemovedMessage,
  AgentMonitorRendererConfiguration,
  AgentMonitorStateMessage,
  LegacySerializedSessionState,
  ReadAgentMonitorArtifactRequest,
} from '@vibecook/puppeteer-runtime';
import type { BuiltinAgentKind } from '@vibecook/puppeteer-builtin-providers';
import type { WorkspaceDiff } from '@vibecook/puppeteer-workspaces';

export type { WorkspaceDiff } from '@vibecook/puppeteer-workspaces';
export type AgentKind = BuiltinAgentKind;
export type WorkspaceInfo = AgentWorkspaceInfo;
export type PromptReceipt = CorePromptReceipt;
export type WorkspaceFinalEvent = AgentWorkspaceFinal;
export type {
  AcknowledgeAgentFailureRequest,
  AgentMonitorNotificationMessage,
  AgentMonitorRemovedMessage,
  AgentMonitorRendererConfiguration,
  AgentMonitorStateMessage,
  ReadAgentMonitorArtifactRequest,
} from '@vibecook/puppeteer-runtime';
export const ACCOUNT_USAGE_AGENTS = ['claude', 'codex', 'grok'] as const;
export type AccountUsageAgent = (typeof ACCOUNT_USAGE_AGENTS)[number];

export interface AgentAccountUsage {
  agent: AccountUsageAgent;
  result: AccountUsageFetchResult;
  /** The last good snapshot is retained when a later refresh fails. */
  stale?: boolean;
  refreshFailure?: AccountUsageFailure;
}

export interface AgentAccountUsageBatch {
  refreshedAt: string;
  entries: AgentAccountUsage[];
}

export interface CreateAgentSessionOptions {
  agent: AgentKind;
  cwd?: string;
  title?: string;
  workspace?: {
    mode: 'direct' | 'exclusive' | 'worktree';
    path?: string;
    resumeBranch?: string;
    resumeRoot?: string;
  };
  resume?: string;
}

export interface AgentSessionInfo extends Omit<RuntimeAgentSessionInfo, 'agent'> {
  agent: AgentKind;
  /** True only when Godview deliberately launched the Puppeteer Imposter for this pane. */
  emulated?: boolean;
  session: SessionSummary;
}

export type AgentSessionFailure = RuntimeAgentSessionFailure;

export type CreateAgentSessionResult = AgentSessionInfo | AgentSessionFailure;

export type SerializedSessionState = LegacySerializedSessionState;

export interface AgentStateMessage {
  runtimeSessionId: string;
  state: SerializedSessionState;
  observationLevel: ObservationLevel;
}

export interface AgentStateBatch {
  sequence: number;
  states: AgentStateMessage[];
}

export interface AgentSessionSnapshot {
  info: AgentSessionInfo;
  state?: AgentStateMessage;
  final?: WorkspaceFinalEvent;
}

export interface SubmitPromptOptions {
  runtimeSessionId: string;
  text: string;
}

export interface ScenarioRecordingStatus {
  runtimeSessionId: string;
  active: boolean;
  filePath: string;
  fileName: string;
  startedAt: string;
  updatedAt: string;
  eventCount: number;
  droppedEventCount: number;
  truncated: boolean;
  error?: string;
}

export type StartScenarioRecordingResult = { cancelled: true } | { cancelled: false; status: ScenarioRecordingStatus };

export interface PaneRehydrationRequest {
  meta: unknown;
  sessionId: string;
  paneId: string;
}

/** One ended application PTY being handed to a live interactive shell. */
export interface TerminalSessionHandoff {
  handoffId: string;
  previousSessionId: string;
  /** Stable bubble identity even when a pane still names an older restore alias. */
  monitorIdentity: string;
  session: SessionSummary;
}

export interface PuppeteerBridge {
  createAgentSession(opts: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
  listAgentSessions(): Promise<AgentSessionSnapshot[]>;
  /** Answers Ghosttea's rehydration request for a persisted pane whose session is gone. */
  rehydratePane(request: PaneRehydrationRequest): Promise<SessionSummary | null>;
  onAgentSession(cb: (info: AgentSessionInfo) => void): () => void;
  onAgentRemoved(cb: (runtimeSessionId: string) => void): () => void;
  submitPrompt(opts: SubmitPromptOptions): Promise<PromptReceipt>;
  onAgentState(cb: (state: AgentStateMessage) => void): () => void;
  agentMonitorConfiguration(): Promise<AgentMonitorRendererConfiguration>;
  listAgentMonitors(): Promise<AgentMonitorStateMessage[]>;
  onAgentMonitorState(cb: (message: AgentMonitorStateMessage) => void): () => void;
  onAgentMonitorNotification(cb: (message: AgentMonitorNotificationMessage) => void): () => void;
  onAgentMonitorRemoved(cb: (message: AgentMonitorRemovedMessage) => void): () => void;
  acknowledgeAgentFailure(request: AcknowledgeAgentFailureRequest): Promise<boolean>;
  readAgentMonitorArtifact(request: ReadAgentMonitorArtifactRequest): Promise<MonitorArtifactReadResult>;
  workspaceDiff(runtimeSessionId: string): Promise<WorkspaceDiff | null>;
  onWorkspaceFinal(cb: (event: WorkspaceFinalEvent) => void): () => void;
  scenarioRecordings(): Promise<ScenarioRecordingStatus[]>;
  startScenarioRecording(runtimeSessionId: string): Promise<StartScenarioRecordingResult>;
  stopScenarioRecording(runtimeSessionId: string): Promise<ScenarioRecordingStatus>;
  onScenarioRecording(cb: (status: ScenarioRecordingStatus) => void): () => void;
  accountUsage(): Promise<AgentAccountUsageBatch>;
  refreshAccountUsage(): Promise<AgentAccountUsageBatch>;
  onAccountUsage(cb: (batch: AgentAccountUsageBatch) => void): () => void;
}
