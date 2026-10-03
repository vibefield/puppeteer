import type {
  AgentRowKind,
  AgentTier,
  MonitorDeviceRef,
  MonitorModelChange,
  MonitorModelSnapshot,
  MonitorSpawnDevice,
  MonitorSpawnTarget,
} from '@vibecook/puppeteer-view-sdk/model';
import type { AgentMonitorSource } from '../store.js';

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
  /** The canonical root the host folds the project to: the key its colour is dealt by. */
  readonly projectKey?: string | undefined;
  readonly workspace?:
    | {
        readonly root?: string | undefined;
        readonly sourcePath?: string | undefined;
        readonly branch?: string | undefined;
      }
    | undefined;
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
    };

export interface CreateMonitorBackendOptions {
  runs: AgentMonitorSource;
  host: MonitorHostPort;
  identity: ProjectIdentityStore;
  sink: MonitorCommandSink;
  clock?: MonitorClock | undefined;
  scheduler?: MonitorScheduler | undefined;
  /** The longest reply or question text a row carries. Default 280. */
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
  /** Which rows a screen shows in its active pane; an empty list clears the screen (L5). */
  reportShown(screenId: string, ids: readonly string[]): void;
  /** Resolves once the runtime's all-runs listing has been merged. */
  readonly ready: Promise<void>;
  dispose(): void;
}
