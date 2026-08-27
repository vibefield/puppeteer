import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type {
  AccountUsageFailure,
  AccountUsageFetchResult,
  AccountUsageProvider,
  AgentProviderDescriptor,
  MonitorArtifactReadResult,
  PromptReceipt as CorePromptReceipt,
} from '@vibecook/puppeteer-core';
import type {
  AgentSessionFailure as RuntimeAgentSessionFailure,
  AgentSessionInfo as RuntimeAgentSessionInfo,
  AgentWorkspaceFinal,
  AgentWorkspaceInfo,
} from '@vibecook/puppeteer-runtime';
import type {
  AcknowledgeAgentFailureRequest,
  AgentMonitorNotificationMessage,
  AgentMonitorRemovedMessage,
  AgentMonitorStateMessage,
  ReadAgentMonitorArtifactRequest,
} from './main/monitor-ipc.js';
import type { WorkspaceDiff } from '@vibecook/puppeteer-workspaces';

export type { WorkspaceDiff } from '@vibecook/puppeteer-workspaces';
export type AgentKind = AgentProviderDescriptor['id'];
export type WorkspaceInfo = AgentWorkspaceInfo;
export type PromptReceipt = CorePromptReceipt;
export type WorkspaceFinalEvent = AgentWorkspaceFinal;
export type {
  AcknowledgeAgentFailureRequest,
  AgentMonitorNotificationMessage,
  AgentMonitorRemovedMessage,
  AgentMonitorStateMessage,
  ReadAgentMonitorArtifactRequest,
} from './main/monitor-ipc.js';
export interface AccountUsageEntry {
  provider: AccountUsageProvider;
  result: AccountUsageFetchResult;
  /** The last good snapshot is retained when a later refresh fails. */
  stale?: boolean;
  refreshFailure?: AccountUsageFailure;
}

export interface AccountUsageBatch {
  refreshedAt: string;
  entries: AccountUsageEntry[];
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
}

export interface AgentSessionInfo extends RuntimeAgentSessionInfo {
  session: SessionSummary;
}

export type AgentSessionFailure = RuntimeAgentSessionFailure;

export type CreateAgentSessionResult = AgentSessionInfo | AgentSessionFailure;

export interface AgentSessionSnapshot {
  info: AgentSessionInfo;
  final?: WorkspaceFinalEvent;
}

export interface SubmitPromptOptions {
  runtimeSessionId: string;
  text: string;
}

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
  listAgentMonitors(): Promise<AgentMonitorStateMessage[]>;
  onAgentMonitorState(cb: (message: AgentMonitorStateMessage) => void): () => void;
  onAgentMonitorNotification(cb: (message: AgentMonitorNotificationMessage) => void): () => void;
  onAgentMonitorRemoved(cb: (message: AgentMonitorRemovedMessage) => void): () => void;
  acknowledgeAgentFailure(request: AcknowledgeAgentFailureRequest): Promise<boolean>;
  readAgentMonitorArtifact(request: ReadAgentMonitorArtifactRequest): Promise<MonitorArtifactReadResult>;
  workspaceDiff(runtimeSessionId: string): Promise<WorkspaceDiff | null>;
  onWorkspaceFinal(cb: (event: WorkspaceFinalEvent) => void): () => void;
  accountUsage(): Promise<AccountUsageBatch>;
  refreshAccountUsage(): Promise<AccountUsageBatch>;
  onAccountUsage(cb: (batch: AccountUsageBatch) => void): () => void;
}
