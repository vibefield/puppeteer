import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AccountUsageBatch } from '@vibefield/puppeteer-core';
import type {
  HistorySearchRequest,
  HistorySearchResponse,
  HistorySearchStatus,
  HistorySessionFacts,
} from '@vibefield/puppeteer-views';
import type { MonitorHostTerminal } from '@vibefield/puppeteer-monitor';
import type { MonitorModelChange, MonitorModelSnapshot } from '@vibefield/puppeteer-view-sdk/model';
import type {
  LauncherAgent,
  LauncherHistoryStatus,
  LauncherRecentRequest,
  LauncherSession,
  LauncherWordHit,
  LauncherWordsRequest,
} from '@vibefield/puppeteer-views/launcher';
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
} from '@vibefield/puppeteer-core';
import type {
  AgentSessionFailure as RuntimeAgentSessionFailure,
  AgentSessionInfo as RuntimeAgentSessionInfo,
  AgentWorkspaceFinal,
  AgentWorkspaceInfo,
  ProfileLoginResult,
  ReleaseCheckResult,
} from '@vibefield/puppeteer-runtime';
import type {
  AgentMonitorNotificationMessage,
  AgentMonitorRemovedMessage,
  AgentMonitorStateMessage,
} from './main/monitor-ipc.js';
import type { WorkspaceDiff } from '@vibefield/puppeteer-workspaces';

export type { WorkspaceDiff } from '@vibefield/puppeteer-workspaces';
export type AgentKind = AgentProviderDescriptor['id'];
export type WorkspaceInfo = AgentWorkspaceInfo;
export type PromptReceipt = CorePromptReceipt;
export type WorkspaceFinalEvent = AgentWorkspaceFinal;
export type {
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
} from '@vibefield/puppeteer-core';
export type { ProfileLoginResult, ReleaseCheckResult } from '@vibefield/puppeteer-runtime';

export type { AccountUsageBatch, AccountUsageEntry } from '@vibefield/puppeteer-core';

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
  /** Registered profile id to run under; absent means the runtime's own default account. */
  profile?: string;
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

/* Transcript history (RFC 007): the shapes live with the views that read them
   (`@vibefield/puppeteer-views`) and are re-exported here for the main process
   and the preload. (The UI's usage ledger records went with L11; the backend
   holds the cost window in memory.) */
export type {
  HistoryOriginSource,
  HistorySearchHit,
  HistorySearchReadiness,
  HistorySearchRequest,
  HistorySearchResponse,
  HistorySearchStatus,
  HistorySessionFacts,
} from '@vibefield/puppeteer-views';
export type { MonitorHostTerminal } from '@vibefield/puppeteer-monitor';
export type { MonitorModelChange, MonitorModelSnapshot } from '@vibefield/puppeteer-view-sdk/model';

/* The empty pane launcher (QL-1): the port's questions as main answers them.
   The shapes are the launcher's own (`@vibefield/puppeteer-views/launcher`);
   a row may carry the profile id main matched, which only this host reads. */
export type {
  LauncherHistoryStatus,
  LauncherRecentRequest,
  LauncherWordHit,
  LauncherWordsRequest,
} from '@vibefield/puppeteer-views/launcher';

/** A launcher row with the profile a launch runs under: the provider's persisted default. */
export interface LauncherAgentRow extends LauncherAgent {
  profileId?: string;
}

/** A past session with the profile whose data root the history daemon read it from. */
export interface LauncherSessionRow extends LauncherSession {
  profileId?: string;
}

export interface LauncherRecentAnswer {
  status: LauncherHistoryStatus;
  sessions: LauncherSessionRow[];
}

export interface LauncherWordsAnswer {
  answered: boolean;
  hits: LauncherWordHit[];
  /** Why main would not answer at all (a sender that is not a Godview window). */
  refused?: string;
}

/** Resume a past conversation by its provider-native id (QL-D10), not by a run this Godview holds. */
export interface ResumeNativeSessionRequest {
  providerId: string;
  nativeSessionId: string;
  cwd?: string;
  profileId?: string;
}

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
  /**
   * THE CHROME'S FEED (M19): every run's full monitor state, for the chrome outside the monitor views (the inspector,
   * Find, the deck's pane frames, split sessions) and nothing else. The views, the counts and the status shortcuts
   * read the model (`onMonitorModel`).
   */
  listChromeMonitors(): Promise<AgentMonitorStateMessage[]>;
  onChromeMonitorState(cb: (message: AgentMonitorStateMessage) => void): () => void;
  onChromeMonitorRemoved(cb: (message: AgentMonitorRemovedMessage) => void): () => void;
  onAgentMonitorNotification(cb: (message: AgentMonitorNotificationMessage) => void): () => void;
  /**
   * The monitor model (MV-2): asks main for a snapshot, at mount and again after a gap. It arrives through
   * `onMonitorModel`, on the one ordered channel the changes travel (M23); a window that is no Godview tab gets none.
   */
  requestMonitorSnapshot(): void;
  /** The model for this window's replica: the snapshot it asked for, and every change, in revision order. */
  onMonitorModel(cb: (update: MonitorModelSnapshot | MonitorModelChange) => void): () => void;
  /** This window's bare-terminal candidates: its panes' sessions, minus those exited or closing (a window fact). */
  reportMonitorTerminals(terminals: MonitorHostTerminal[]): void;
  /** The rows this window shows in its active pane (L5): any window showing a row clears its unread mark. */
  reportMonitorShown(ids: string[]): void;
  /** Acknowledges a crashed row's failure (M3); false when the row has none to acknowledge. */
  acknowledgeMonitorRow(id: string): Promise<boolean>;
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
  /** The launcher's agent catalog: launch providers in order, their install state, last launch and default profile. */
  launcherAgents(): Promise<LauncherAgentRow[]>;
  /** The launcher's past sessions: this folder's project (`here`) or every project (`all`), newest first. */
  launcherRecent(request: LauncherRecentRequest): Promise<LauncherRecentAnswer>;
  /** The launcher's words lane over the history daemon's search. */
  launcherWords(request: LauncherWordsRequest): Promise<LauncherWordsAnswer>;
  /** Resume a past conversation by provider-native id; the caller mounts the returned session. */
  resumeNativeSession(request: ResumeNativeSessionRequest): Promise<CreateAgentSessionResult>;
}
