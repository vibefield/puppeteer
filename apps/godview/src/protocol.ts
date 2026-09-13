import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AccountUsageBatch } from '@vibecook/puppeteer-core';
import type {
  HistorySearchRequest,
  HistorySearchResponse,
  HistorySearchStatus,
  HistorySessionFacts,
  UsageHistoryKey,
  UsageLedgerRecord,
} from '@vibecook/puppeteer-views';
import type {
  AgentInstallation,
  AgentProfile,
  AgentProviderDescriptor,
  DistributionProvider,
  ProfileFailure,
  ProfileIdentity,
  ProfileProvider,
  PromptReceipt as CorePromptReceipt,
  UpdateReceipt,
} from '@vibecook/puppeteer-core';
import type {
  AgentSessionFailure as RuntimeAgentSessionFailure,
  AgentSessionInfo as RuntimeAgentSessionInfo,
  AgentWorkspaceFinal,
  AgentWorkspaceInfo,
  ProfileLoginResult,
  ReleaseCheckResult,
} from '@vibecook/puppeteer-runtime';
import type {
  AcknowledgeAgentFailureRequest,
  AgentMonitorNotificationMessage,
  AgentMonitorRemovedMessage,
  AgentMonitorStateMessage,
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
} from './main/monitor-ipc.js';
export type {
  AgentInstallation,
  AgentProfile,
  DistributionProvider,
  ProfileFailure,
  ProfileIdentity,
  ProfileProvider,
  UpdateReceipt,
} from '@vibecook/puppeteer-core';
export type { ProfileLoginResult, ReleaseCheckResult } from '@vibecook/puppeteer-runtime';

export type { AccountUsageBatch, AccountUsageEntry } from '@vibecook/puppeteer-core';

/** One inspection of every executable the host can find, with the descriptors that name them. */
export interface AgentInstallationsSnapshot {
  providers: DistributionProvider[];
  installations: AgentInstallation[];
  inspectedAt: string;
}

export interface InstallationsRequest {
  /** Discard the runtime's cached inventory before inspecting. */
  refresh?: boolean;
}

export interface CheckReleasesRequest {
  providerId: string;
}

export interface UpdateInstallationRequest {
  providerId: string;
}

export interface CreateProfileRequest {
  providerId: string;
  label: string;
}

export interface StartProfileLoginRequest {
  profileId: string;
  cwd?: string;
}

/** Provider id -> the profile new terminals bind to when none is named. */
export type ProfileDefaults = Record<string, string>;

export interface SetProfileDefaultRequest {
  providerId: string;
  /** Null clears the default, so new terminals inherit nothing for that provider. */
  profileId: string | null;
}

export interface NewTerminalTabRequest {
  cwd?: string;
  /** At most one profile per provider; absent means the persisted defaults. */
  profileIds?: string[];
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

/**
 * The project an agent runs in, dealt by main the first time an agent runs in
 * a source root (design-system record §02). Colour belongs to the project:
 * the renderer turns `seq` into the hue, and a pane wears the colour of the
 * agent mounted in it, never one of its own.
 */
export interface AgentProjectRef {
  /** The canonical source root: the real path, folded to the repository a worktree or copy was cut from. */
  key: string;
  /** The root's folder name. */
  name: string;
  /** First-seen order, never reused; the hue is dealt from it. */
  seq: number;
}

export interface AgentSessionInfo extends RuntimeAgentSessionInfo {
  session: SessionSummary;
  /** Absent only until main has folded the workspace to its project. */
  project?: AgentProjectRef;
}

export type AgentSessionFailure = RuntimeAgentSessionFailure;

export type CreateAgentSessionResult = AgentSessionInfo | AgentSessionFailure;

export interface AgentSessionSnapshot {
  info: AgentSessionInfo;
  final?: WorkspaceFinalEvent | undefined;
}

export interface SubmitPromptOptions {
  runtimeSessionId: string;
  text: string;
}

/** The pane's stop verb: whether the agent's native interrupt was delivered. */
export type AgentInterruptResult =
  { accepted: true } | { accepted: false; reason: 'agent-not-running' | 'human-input-conflict' | string };

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

/* Transcript history (RFC 007) and the UI's usage ledger records: the shapes
   live with the views that read them (`@vibecook/puppeteer-views`) and are
   re-exported here for the main process and the preload. */
export type {
  HistoryOriginSource,
  HistorySearchHit,
  HistorySearchReadiness,
  HistorySearchRequest,
  HistorySearchResponse,
  HistorySearchStatus,
  HistorySessionFacts,
  UsageHistoryKey,
  UsageLedgerRecord,
  UsageSeriesRecord,
} from '@vibecook/puppeteer-views';

export interface PuppeteerBridge {
  createAgentSession(opts: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
  listAgentSessions(): Promise<AgentSessionSnapshot[]>;
  /** Answers Ghosttea's rehydration request for a persisted pane whose session is gone. */
  rehydratePane(request: PaneRehydrationRequest): Promise<SessionSummary | null>;
  onAgentSession(cb: (info: AgentSessionInfo) => void): () => void;
  onAgentRemoved(cb: (runtimeSessionId: string) => void): () => void;
  submitPrompt(opts: SubmitPromptOptions): Promise<PromptReceipt>;
  /** Stop the agent's current turn with its own native interrupt (what ^C does in its TUI). */
  interruptAgent(runtimeSessionId: string): Promise<AgentInterruptResult>;
  /** Resume an exited agent from its own continuation; the caller mounts the returned session. */
  resumeAgentSession(runtimeSessionId: string): Promise<CreateAgentSessionResult>;
  listAgentMonitors(): Promise<AgentMonitorStateMessage[]>;
  onAgentMonitorState(cb: (message: AgentMonitorStateMessage) => void): () => void;
  onAgentMonitorNotification(cb: (message: AgentMonitorNotificationMessage) => void): () => void;
  onAgentMonitorRemoved(cb: (message: AgentMonitorRemovedMessage) => void): () => void;
  acknowledgeAgentFailure(request: AcknowledgeAgentFailureRequest): Promise<boolean>;
  workspaceDiff(runtimeSessionId: string): Promise<WorkspaceDiff | null>;
  onWorkspaceFinal(cb: (event: WorkspaceFinalEvent) => void): () => void;
  accountUsage(): Promise<AccountUsageBatch>;
  refreshAccountUsage(): Promise<AccountUsageBatch>;
  onAccountUsage(cb: (batch: AccountUsageBatch) => void): () => void;
  /** Every executable the host can find for every provider that declares distribution facts. */
  installations(request?: InstallationsRequest): Promise<AgentInstallationsSnapshot>;
  /** Explicit user action: the only path allowed to reach the network. */
  checkReleases(request: CheckReleasesRequest): Promise<ReleaseCheckResult>;
  /** Runs the provider's own updater; the receipt is a fresh inspection, never parsed output. */
  updateInstallation(request: UpdateInstallationRequest): Promise<UpdateReceipt>;
  profileProviders(): Promise<ProfileProvider[]>;
  profiles(): Promise<AgentProfile[]>;
  createProfile(request: CreateProfileRequest): Promise<AgentProfile | ProfileFailure>;
  /** Opens the native login in its own tab; main verifies the account when that terminal ends. */
  startProfileLogin(request: StartProfileLoginRequest): Promise<ProfileLoginResult>;
  verifyProfile(profileId: string): Promise<ProfileIdentity | ProfileFailure>;
  removeProfile(profileId: string): Promise<boolean>;
  onProfiles(cb: (profiles: AgentProfile[]) => void): () => void;
  profileDefaults(): Promise<ProfileDefaults>;
  setProfileDefault(request: SetProfileDefaultRequest): Promise<ProfileDefaults>;
  /** A new tab whose pane environment carries the named profiles, or the persisted defaults. */
  newTerminalTab(request?: NewTerminalTabRequest): Promise<boolean>;
  /** Liveness and readiness of the transcript history daemon. */
  historyStatus(): Promise<HistorySearchStatus>;
  /** Titles and canonical ids for live runs, by provider-native session id. */
  historyFacts(nativeSessionIds: string[]): Promise<HistorySessionFacts[]>;
  /** Words said or heard in live sessions, joined back to their runs. */
  historySearch(request: HistorySearchRequest): Promise<HistorySearchResponse>;
  /** The persisted usage ledger for a conversation, or null when none was saved. */
  loadUsageHistory(key: UsageHistoryKey): Promise<UsageLedgerRecord | null>;
  /** Persist the live agents' usage ledgers; main merges them into the cache. */
  saveUsageHistory(records: UsageLedgerRecord[]): Promise<void>;
}
