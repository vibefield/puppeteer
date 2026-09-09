import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type {
  AccountUsageFailure,
  AccountUsageFetchResult,
  AccountUsageProvider,
  AgentInstallation,
  AgentProfile,
  AgentProviderDescriptor,
  DistributionProvider,
  MonitorArtifactReadResult,
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

export interface AccountUsageEntry {
  provider: AccountUsageProvider;
  result: AccountUsageFetchResult;
  /** The account this reading belongs to; absent while no registry answer exists. */
  profileId?: string;
  /** Registry label for that account, so a row can name it without a second lookup. */
  profileLabel?: string;
  /** The last good snapshot is retained when a later refresh fails. */
  stale?: boolean;
  refreshFailure?: AccountUsageFailure;
}

export interface AccountUsageBatch {
  refreshedAt: string;
  entries: AccountUsageEntry[];
}

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

/* Transcript history, read from an external loopback daemon that indexes every
   installed agent's own session records. Godview joins its answers to live runs
   by the provider-native session id; nothing here names a provider. */

export type HistorySearchReadiness = 'ready' | 'building' | 'catching-up' | 'stale' | 'failed';
export type HistoryOriginSource = 'setting' | 'environment' | 'announcement' | 'default';

export interface HistorySearchStatus {
  origin?: string;
  source?: HistoryOriginSource;
  reachable: boolean;
  protocolVersion?: number;
  /** What this daemon generation can do; older ones are answered the long way. */
  capabilities?: { sessionScope: boolean; prefix: boolean };
  canonicalReady?: boolean;
  readiness?: HistorySearchReadiness;
  progress?: { done: number; total: number };
  /** One sentence for the sheet's foot when something is off. */
  detail?: string;
  checkedAt: string;
}

/** What the history daemon knows about one live run, by its provider-native id. */
export interface HistorySessionFacts {
  nativeSessionId: string;
  sessionId: string;
  rootSessionId: string;
  title?: string;
  summary?: string;
  cwd?: string;
  updatedAt: number;
  streamState: string;
}

export interface HistorySearchRequest {
  query: string;
  /** Provider-native ids of the live runs to scope to; empty means everything the daemon knows. */
  nativeSessionIds: string[];
  /** Earliest live start, so a daemon without session scope narrows by time instead. */
  afterMs?: number;
  limit?: number;
  /** Widen word fragments; on by default where the daemon supports it. */
  prefix?: boolean;
}

/** One transcript row the history daemon matched, attributed to its navigable root. */
export interface HistorySearchHit {
  sessionId: string;
  rootSessionId: string;
  /** The root's provider-native id: the join key to a live run. */
  nativeSessionId?: string;
  title?: string;
  timelineId: string;
  /** `user` or `agent`; anything else is shown as itself. */
  kind: string;
  at?: number;
  /** Matches are marked with `[` and `]`. */
  snippet: string;
}

export interface HistorySearchResponse {
  status: HistorySearchStatus;
  /** False when the daemon had no answer; a sheet keeps what it last showed rather than saying "no matches". */
  answered: boolean;
  hits: HistorySearchHit[];
  /** The daemon clipped at its limit, so some sessions may be under-reported. */
  clipped: boolean;
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
}
