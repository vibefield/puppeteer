/**
 * The view contract: a monitor view is a manifest and a mount.
 *
 * A view is pure presentation. It receives the replica's model and its own UI
 * input as plain values, draws them, keeps only UI state (hover, the scrubbed
 * moment, scroll, its own animation and physics) and calls three commands, and
 * a fourth where its host lends one (`openEnded`, TV-8). It computes no
 * business fact, syncs nothing, and touches nothing outside the root it is
 * given (the wall, MV-W1…W5).
 *
 * Everything handed to a view is plain data, so the same contract can later
 * cross into an isolated realm unchanged.
 */

import type {
  AgentStatus,
  AgentView,
  ModelChanges,
  MonitorEndedRow,
  MonitorModel,
  MonitorPastSnapshot,
  MonitorSpawnMenu,
  MonitorSpawnTarget,
} from './model.js';

/** The contract's major. A host refuses a view built for a newer one; minors only add optional fields (MV-D10). */
export const MONITOR_VIEW_SDK_MAJOR = 1;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * Where a view may draw, in CSS pixels of its own root (MV-D19).
 *
 * `insets` are advisory: each view keeps its own treatment of the host's
 * chrome. `obstacles` are the chrome's real rectangles, for views that steer
 * around it (the swarm's bodies, the bloom's words).
 */
export interface StageGeometry {
  readonly width: number;
  readonly height: number;
  readonly insets: Insets;
  readonly obstacles: readonly Rect[];
}

/** A project's lightness and chroma; the view host's tint turns a sequence into a hue. */
export interface ProjectTint {
  readonly l: number;
  readonly c: number;
}

export interface SwarmPalette {
  readonly surface: string;
  readonly ink: string;
  readonly gridLine: string;
  readonly orange: string;
  readonly green: string;
  readonly blue: string;
}

export interface TimelinePalette {
  readonly ground: string;
  readonly muted: string;
  readonly border: string;
}

/**
 * The live tokens, resolved by the host. Passed rather than read: canvases
 * cannot inherit a custom property, and a view that resolved its own would be
 * a second reader of the design system.
 */
export interface MonitorPalette {
  readonly tint: ProjectTint;
  readonly neutral: string;
  readonly status: Readonly<Record<AgentStatus, string>>;
  /** The same, as `"r, g, b"` for canvas composition. */
  readonly statusRgb: Readonly<Record<AgentStatus, string>>;
  readonly stage: string;
  readonly text: { readonly primary: string; readonly secondary: string; readonly tertiary: string };
  readonly swarm: SwarmPalette;
  readonly rain: {
    readonly stage: string;
    readonly activeHead: string;
    readonly hoverTailRgb: string;
    readonly status: Readonly<
      Record<AgentStatus, { readonly head: string; readonly tailRgb: string; readonly speed?: number }>
    >;
    /** The words of the rain's own DOM (its tooltip), by the status they describe (M46). */
    readonly ink: Readonly<Record<AgentStatus, string>>;
    /** A focused control's ring on the rain's dark ground (M46). */
    readonly focus: string;
  };
  readonly timeline: TimelinePalette;
}

export interface MonitorTheme {
  readonly scheme: 'light' | 'dark';
  readonly tokens: MonitorPalette;
  readonly reducedMotion: boolean;
  /**
   * The host's animations switch (the lab's and the catalog's). Off: no loop runs, and the view holds still: nothing
   * is simulated (the swarm's physics solve nothing), and a row that arrives is drawn where it spawns, at its size.
   */
  readonly animations: boolean;
}

/**
 * An ended lane as a view sees it: the backend's row, with what only the window knows joined by the host, as
 * `AgentView` joins it. Lit and readable, and never the backend's to open: its `past:` id goes through no command but
 * the host's own `openEnded` (TV-8), and where the host lends none the lane is not a control.
 */
export interface EndedLaneView extends MonitorEndedRow {
  /** The project's colour in the current theme; the neutral ramp for no project. */
  readonly colour: string;
  /**
   * The host is showing another group (its device or profile filter), by `AgentView.receded`'s rule: the lane keeps
   * its place and is drawn faint. Under a profile filter a run whose profile is unknown recedes.
   */
  readonly receded: boolean;
}

/**
 * The record's past (capability `history`). The host builds it once per snapshot and keeps the SAME object while a
 * re-read brings nothing new (a changed `readAt` alone is nothing new), so a view that keys on it redraws only for a
 * past that moved.
 */
export interface MonitorHistory extends Omit<MonitorPastSnapshot, 'ended'> {
  readonly ended: readonly EndedLaneView[];
}

/** What the backend lends a view beyond the model (MV-D4). */
export interface MonitorCapabilities {
  /** The desktops and profiles a new terminal can be born under. Absent: a create opens one here at once. */
  readonly spawn?: MonitorSpawnMenu | undefined;
  /**
   * The record's past over the view's day (`[now − 24 h, now]`), read by the host while a mounted view declares
   * `capabilities.optional: ['history']` in its manifest. Absent: this host has no record (puppeteer's own Godview,
   * the phone), or the first answer has not come; a view draws runtime state alone, exactly as before.
   */
  readonly history?: MonitorHistory | undefined;
}

export type MonitorCapabilityName = 'spawn' | 'history';

/** A view's tunable numbers. The host owns defaults, clamping and persistence. */
export interface MonitorParameterDefinition {
  readonly key: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly defaultValue: number;
}

export interface MonitorParameterGroup {
  readonly title: string;
  readonly controls: readonly MonitorParameterDefinition[];
}

export type MonitorParameterValues = Readonly<Record<string, number>>;

/** Everything a view is handed. Every value is plain data. */
export interface MonitorViewInput {
  readonly model: MonitorModel;
  readonly changes: ModelChanges;
  readonly stage: StageGeometry;
  readonly theme: MonitorTheme;
  readonly parameters: MonitorParameterValues;
  readonly capabilities: MonitorCapabilities;
}

/**
 * What a view tells its host about itself. It replaces every place a host
 * used to read a view's DOM (the renderer marker, the physics mode, the
 * bloom's hold on keys).
 */
export interface ViewReport {
  /** What is drawing. `unavailable` is honest: the view says so on its stage too. */
  readonly renderer?: 'webgpu' | 'canvas2d' | 'dom' | 'unavailable' | undefined;
  /** Where a view's simulation runs. */
  readonly physics?: 'worker' | 'inline' | undefined;
  /** The view holds key events (an open bloom): the host's own keys stand aside. */
  readonly keysHeld?: boolean | undefined;
}

/** The host's answer to a create (SB §2.6): a refusal is an answer, not an error, so the promise never rejects. */
export interface MonitorCreateAnswer {
  readonly opened: boolean;
}

/** The three commands a view may call (MV-D5), and TV-8's optional fourth, which only some hosts lend. */
export interface MonitorViewCommands {
  /** Show this agent in the active pane. */
  select(agentId: string): void;
  /**
   * Open a terminal: where the gesture happened, and the desktop and profile chosen. Resolves with the host's answer
   * once it has acted — opened, or refused — so a view can wait for the new row and give up at once on a refusal
   * (SB §2.6). It never rejects; a host that cannot tell answers `{ opened: true }` at once.
   */
  create(at?: { readonly x: number; readonly y: number }, target?: MonitorSpawnTarget): Promise<MonitorCreateAnswer>;
  report(report: ViewReport): void;
  /**
   * Open a run that ended where the host keeps past sessions (TV-8). `id` is a `MonitorEndedRow`'s id (`past:…`), and
   * nothing else is ever passed. The HOST answers it: it is never sent to the backend, which routes only the model's
   * ids. ABSENT wherever no record is lent or the host has nowhere to open a past session (puppeteer's own Godview,
   * the phone): a view reads its presence, and without it an ended lane is lit and read, never a control. Whether it
   * is there is settled when the view mounts.
   */
  openEnded?(id: string): void;
}

/** The view's mark, drawn by the host's bar (MV-D6) as filled paths in currentColor. */
export interface MonitorViewMark {
  readonly viewBox: string;
  readonly paths: readonly string[];
}

/** A key a view takes while it is focused, declared so the bar can print it (MV-D8). Never a ⌘ chord. */
export interface MonitorViewKey {
  readonly key: string;
  readonly label: string;
}

export interface MonitorViewManifest {
  readonly sdk: typeof MONITOR_VIEW_SDK_MAJOR;
  readonly id: string;
  readonly label: string;
  readonly mark: MonitorViewMark;
  readonly parameters: readonly MonitorParameterGroup[];
  /** Set when the defaults were re-decided, so every installation lands on the new ones. */
  readonly parametersRevision?: string | undefined;
  readonly capabilities?: { readonly optional?: readonly MonitorCapabilityName[] | undefined } | undefined;
  readonly keys?: readonly MonitorViewKey[] | undefined;
  /** Read by the ambient-motion audit (GT-D15.1): does the view run a loop at rest? */
  readonly motion: { readonly loops: boolean };
}

export interface MonitorViewInstance {
  /** At most once per frame, and only when the input changed. */
  update(input: MonitorViewInput): void;
  unmount(): void;
}

export interface MonitorView {
  readonly manifest: MonitorViewManifest;
  mount(root: HTMLElement, input: MonitorViewInput, commands: MonitorViewCommands): MonitorViewInstance;
}

/** Declares a view, refusing a manifest the contract cannot serve. */
export function defineMonitorView(view: MonitorView): MonitorView {
  const { manifest } = view;
  if (manifest.sdk !== MONITOR_VIEW_SDK_MAJOR) {
    throw new RangeError(
      `view ${manifest.id} targets sdk ${String(manifest.sdk)}; this contract is ${MONITOR_VIEW_SDK_MAJOR}`,
    );
  }
  if (!/^[a-z][a-z0-9-]*$/.test(manifest.id)) throw new RangeError(`view id ${manifest.id} is not a lowercase slug`);
  return view;
}
