import type {
  AgentRowKind,
  AgentTier,
  MonitorDeviceRef,
  MonitorModelChange,
  MonitorModelSnapshot,
  MonitorPastSnapshot,
  MonitorSpawnDevice,
  MonitorSpawnTarget,
} from '@vibecook/puppeteer-view-sdk/model';
import type { AgentMonitorSource } from '../store.js';

/** The runtime's door into the backend: the store's source, plus the one verb the runtime answers (M3). */
export interface MonitorRunSource extends AgentMonitorSource {
  /** Acknowledges a retained, dead failure blocker; the runtime then removes the run and the row goes with it. */
  acknowledgeFailure?(runtimeRunId: string, blockerId: string): Promise<boolean>;
}

/**
 * The ports the backend is built from. Everything a host knows and the runtime
 * does not comes through `MonitorHostPort`; the runtime comes through the
 * store's `AgentMonitorSource` (`runtimeRunSource`); identity through
 * `ProjectIdentityStore` (L4); verbs leave through `MonitorCommandSink`.
 */

/** What only the host knows about one run it manages. */
export interface MonitorHostRun {
  readonly runtimeRunId: string;
  /** When the run was born as the host knows it, epoch ms. */
  readonly createdAt: number;
  readonly provider: { readonly id: string; readonly label: string };
  /** The PTY on this desktop the run is in, when the host holds one. */
  readonly terminalSessionId?: string | undefined;
  /** AR-4: the PTY this run replaced at a resume-when-idle; a pane may still be showing it. */
  readonly replacedTerminalSessionId?: string | undefined;
  /** The stable identity the host keeps for its PTY across handoffs, when it keeps one. */
  readonly terminalIdentity?: string | undefined;
  /**
   * The canonical root the host folds the project to: the key its colour is dealt by. Absent: the backend falls back to
   * the observed directory. Null: the host folds projects itself and has not folded this run's yet, so the row deals
   * nothing and wears the neutral ramp until the host names its key (puppeteer Godview's registry folds a workspace to
   * its Git root asynchronously, and its rows wear the ramp until then).
   */
  readonly projectKey?: string | null | undefined;
  readonly workspace?:
    | {
        readonly root?: string | undefined;
        readonly sourcePath?: string | undefined;
        readonly branch?: string | undefined;
      }
    | undefined;
  /**
   * A branch the host supplies for when the observation names none (M26): shown when the runtime saw no repository
   * (`git: null`) or no branch (a detached HEAD), and when nothing looked. Puppeteer's Godview supplies its
   * workspace's branch, as its seam fell back to it; VibeField supplies none, which keeps its observation-first rule.
   */
  readonly fallbackBranch?: string | undefined;
  /** The terminal's own directory, the last fallback for the project's name. */
  readonly cwd?: string | undefined;
  readonly profileId?: string | undefined;
  /** The Agent Profile SET the run was born under, when the host knows it. */
  readonly profileSet?: string | undefined;
  /** The label of the account the run is bound to. */
  readonly account?: string | undefined;
  readonly tier?: AgentTier | undefined;
  /** AR-4: the host's word for a run nothing drives yet (`resume-when-idle`). */
  readonly pending?: string | undefined;
  /** The host's own liveness. False outranks a lagging mirror: a witnessed exit. */
  readonly alive?: boolean | undefined;
  readonly nativeSessionId?: string | undefined;
}

/** A terminal on this desktop no agent has claimed, as the host lists it. */
export interface MonitorHostTerminal {
  readonly sessionId: string;
  /** The stable identity across PTY handoffs, when the host keeps one. */
  readonly identity?: string | undefined;
  /** Epoch ms; 0 means unknown (a roster row with no birth time). */
  readonly createdAt: number;
  readonly cwd?: string | undefined;
  readonly title?: string | undefined;
  /** What the terminal is doing, in the floor's own word (`foreground-job`). */
  readonly activity?: { readonly kind: string } | undefined;
  /** The Agent Profile SET its shell was born under. */
  readonly profileSet?: string | undefined;
  readonly workloadClass?: string | undefined;
  readonly exited?: boolean | undefined;
}

export interface MonitorHostPersona {
  readonly profileId: string;
  /** The provider's label, as the host's catalog names it. */
  readonly providerLabel: string;
  readonly loggedIn?: boolean | undefined;
}

/** An Agent Profile SET, as the host's feed lists it. */
export interface MonitorHostProfileSet {
  readonly id: string;
  readonly label: string;
  readonly kind: 'native' | 'managed';
  readonly glyph?: string | undefined;
  readonly isDefault?: boolean | undefined;
  readonly personas: readonly MonitorHostPersona[];
}

export interface MonitorHostFacts {
  /** This desktop (`self: true`); every row carries it. */
  readonly device: MonitorDeviceRef;
  readonly runs: readonly MonitorHostRun[];
  readonly terminals: readonly MonitorHostTerminal[];
  /** Null while the feed has not answered: the spawn menu says `reading`. */
  readonly profileSets: readonly MonitorHostProfileSet[] | null;
  /** Other desktops that can take a terminal from here, worded by the host (SB-6, later). */
  readonly spawnPeers?: readonly MonitorSpawnDevice[] | undefined;
}

/** Pull with notify: the backend reads the facts whenever the host says they moved. */
export interface MonitorHostPort {
  getFacts(): MonitorHostFacts;
  subscribe(listener: () => void): () => void;
}

/**
 * The project colour's identity (L4): a key is dealt a sequence the first time
 * an agent runs in it and keeps it for life; a sequence is never reused. The
 * host persists it (fieldd's state store, Godview's registry); the backend
 * only asks.
 */
export interface ProjectIdentityStore {
  seq(key: string): number | undefined;
  /** The key's sequence, dealing the next one when the key is new. */
  deal(key: string): number;
}

/** A window of time the record is asked about, epoch ms. */
export interface MonitorPastWindow {
  readonly sinceMs: number;
  readonly untilMs: number;
}

/** One stretch of a turn with no recorded activity, longer than the cut the backend asked for. */
export interface MonitorRecordedSilence {
  readonly from: number;
  readonly to: number;
}

/** One turn of a recorded session: its first and last activity, and the silences inside it. */
export interface MonitorRecordedTurn {
  readonly firstAt: number;
  readonly lastAt: number;
  readonly silences?: readonly MonitorRecordedSilence[] | undefined;
}

/** A top-level session the record holds activity for in the window. */
export interface MonitorRecordedSession {
  /** The runtime's provider id (the host translates the record's own word): with the native id, the join key. */
  readonly provider: { readonly id: string; readonly label: string };
  readonly nativeSessionId: string;
  /** When the session began, as the record knows it. */
  readonly startedAt?: number | undefined;
  /** Its first and last recorded activity, the whole session's (not clipped to the window). */
  readonly firstAt: number;
  readonly lastAt: number;
  /** The key its project's colour is dealt by, as the host folds it (a live run's `projectKey` for the same place). */
  readonly projectKey?: string | undefined;
  /** The folder name to show; absent: the key's last segment. */
  readonly projectName?: string | undefined;
  /** Its turns that touch the window, oldest first. Absent: only the bounds were read (the floor). */
  readonly turns?: readonly MonitorRecordedTurn[] | undefined;
}

/** What the record answered for a window. */
export interface MonitorRecordedActivity {
  /** `turns` when sessions carry their turns; `bounds` when only first and last activity were read. */
  readonly fidelity: 'turns' | 'bounds';
  /** Some of the record could not be read; `detail` says what, in words. */
  readonly partial: boolean;
  readonly detail?: string | undefined;
  readonly sessions: readonly MonitorRecordedSession[];
}

/**
 * The record, as the host reads it (VibeField: fieldd over rosettad). Asked on demand, never polled by the backend;
 * a refusal is thrown and becomes the past's honest `unavailable`. The backend never imports a record's client: the
 * host owns the reading and the translation, the backend the join and the derivation.
 */
export interface MonitorHistoryPort {
  /**
   * The sessions with activity in the window. `silenceMs` is the backend's cut: report silences inside a turn longer
   * than it. A host that cannot read turns answers `bounds`.
   */
  read(
    window: MonitorPastWindow,
    options: { readonly silenceMs: number; readonly signal?: AbortSignal | undefined },
  ): Promise<MonitorRecordedActivity>;
}

export interface MonitorClock {
  /** Epoch ms. */
  now(): number;
  /** Runs `task` after `delayMs`; the returned function cancels it. */
  schedule(delayMs: number, task: () => void): () => void;
}

/** Runs a task on the next tick; the returned function cancels it. */
export type MonitorScheduler = (task: () => void) => () => void;

/** A select, resolved: the row and what the host can mount for it. */
export interface MonitorSelectTarget {
  readonly id: string;
  readonly kind: AgentRowKind;
  readonly runtimeRunId?: string | undefined;
  readonly terminalSessionId?: string | undefined;
}

/** A create, resolved against the spawn menu. */
export interface MonitorCreateRequest {
  readonly at?: { readonly x: number; readonly y: number } | undefined;
  readonly device: { readonly id: string; readonly self: boolean };
  readonly profileSet?: string | undefined;
}

export interface MonitorCommandSink {
  select(target: MonitorSelectTarget): void | Promise<void>;
  create(request: MonitorCreateRequest): void | Promise<void>;
}

export type MonitorCommand =
  | { readonly type: 'select'; readonly id: string }
  | {
      readonly type: 'create';
      readonly at?: { readonly x: number; readonly y: number } | undefined;
      readonly target?: MonitorSpawnTarget | undefined;
    }
  /** Godview's keep-until-acknowledged flow (M3): a crashed row stays until its failure is acknowledged; this removes it. */
  | { readonly type: 'acknowledge'; readonly id: string };

export interface CreateMonitorBackendOptions {
  runs: MonitorRunSource;
  host: MonitorHostPort;
  identity: ProjectIdentityStore;
  sink: MonitorCommandSink;
  /** The record (capability `history`). Absent: `readPast` answers `unavailable`, and views draw runtime state alone. */
  history?: MonitorHistoryPort | undefined;
  /**
   * Cost across a resumed conversation (M15): `accumulate` is puppeteer Godview's reading (a new epoch of the same
   * provider + native session adds up; a new conversation resets), `current` is VibeField's (the current epoch alone).
   * Default `accumulate`.
   */
  cost?: { readonly acrossEpochs?: 'accumulate' | 'current' | undefined } | undefined;
  /**
   * An agent before its first state (M17): `row` is VibeField's reading (the run is a "starting" row, `observed: false`,
   * and speaks for its terminal at once); `terminal` is puppeteer Godview's (no agent row until the runtime reports a
   * state; the run's terminal stands in, NOT deduped, and the agent row takes its id when the first state arrives).
   * Default `row`.
   */
  unobservedAgents?: 'row' | 'terminal' | undefined;
  clock?: MonitorClock | undefined;
  scheduler?: MonitorScheduler | undefined;
  /**
   * The longest reply, wait or activity text a row carries, in code points. Default: no bound of the backend's
   * own (M21), since Core already bounds the mirror's text.
   */
  replyMaxLength?: number | undefined;
  /** Evidence older than this is stale. Default: core's policy, 30 s. */
  staleAfterMs?: number | undefined;
  /** How often recency is re-read. Default 10 s. */
  recencyIntervalMs?: number | undefined;
  /** Notifications the run table retains. Default 4. */
  notificationCapacity?: number | undefined;
  onError?: ((error: unknown) => void) | undefined;
}

export interface MonitorBackend {
  getSnapshot(): MonitorModelSnapshot;
  subscribe(onChange: (change: MonitorModelChange) => void): () => void;
  /** Routes a validated command to the sink; false when nothing it names exists. */
  command(command: MonitorCommand): boolean;
  /**
   * Which rows a screen shows in its active pane (L5). The first report opens the screen, an empty list included
   * (its pane shows none); it stays open until `forgetScreen`.
   */
  reportShown(screenId: string, ids: readonly string[]): void;
  /**
   * The screen went away (M20): its window closed, its subscription ended. While no screen is open no mark accrues,
   * so forgetting the last one drops every mark, and the next screen to open sees each row for the first time.
   */
  forgetScreen(screenId: string): void;
  /**
   * The id of the row a run is in the current snapshot: the shell's id it carried at a promotion, else its
   * `runtimeRunId`. Undefined while the run has no row (not named, removed, or the backend disposed).
   */
  idOf(runtimeRunId: string): string | undefined;
  /**
   * The record's past for a window, joined with the model as it is now: each row's past before its current status
   * (by provider and native session id, AR-D3), and the runs the record holds that the model does not. Read through
   * the history port at each ask and held nowhere; never rejects (a refusal is `unavailable`, with its words).
   */
  readPast(window: MonitorPastWindow, signal?: AbortSignal): Promise<MonitorPastSnapshot>;
  /** Resolves once the runtime's all-runs listing has been merged. */
  readonly ready: Promise<void>;
  dispose(): void;
}
