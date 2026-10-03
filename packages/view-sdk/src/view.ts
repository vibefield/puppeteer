/**
 * The view contract: a monitor view is a manifest and a mount.
 *
 * A view is pure presentation. It receives the replica's model and its own UI
 * input as plain values, draws them, keeps only UI state (hover, the scrubbed
 * moment, scroll, its own animation and physics) and calls three commands. It
 * computes no business fact, syncs nothing, and touches nothing outside the
 * root it is given (the wall, MV-W1…W5).
 *
 * Everything handed to a view is plain data, so the same contract can later
 * cross into an isolated realm unchanged.
 */

import type { AgentStatus, MonitorAgentRow, MonitorSpawnMenu, MonitorSpawnTarget } from './model.js';

/** The contract's major. A host refuses a view built for a newer one; minors only add optional fields (MV-D10). */
export const MONITOR_VIEW_SDK_MAJOR = 1;

/**
 * One agent as a view sees it: the backend's row, joined by the replica with
 * what only this window knows, and coloured by the view host.
 */
export interface AgentView extends MonitorAgentRow {
  /** The project's colour in the current theme; the neutral ramp for no project. */
  readonly colour: string;
  /** Mounted in the pane the person is working in. */
  readonly active: boolean;
  /** The host is showing another group (VibeField's profile tabs): it keeps its place and is drawn faint. */
  readonly receded: boolean;
  /** The panes showing it here, and the colour of the one it is worked in. Absent: mounted nowhere. */
  readonly attachment?: { readonly panes: number; readonly colour?: string | undefined } | undefined;
  /** Where the person asked for it, for views that place new arrivals spatially. */
  readonly spawnHint?: { readonly x: number; readonly y: number } | undefined;
}

/** The model a view draws. Unchanged agents keep their object across updates (MV-D21). */
export interface MonitorModel {
  readonly revision: number;
  /** In the model's order: agents by birth, then bare terminals. */
  readonly agents: readonly AgentView[];
  readonly byId: ReadonlyMap<string, AgentView>;
}

/** Which agents moved since the view's last update, by id. */
export interface ModelChanges {
  readonly added: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
}

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
      Record<AgentStatus, { readonly head: string; readonly tailRgb: string; readonly speed?: number | undefined }>
    >;
  };
  readonly timeline: TimelinePalette;
}

export interface MonitorTheme {
  readonly scheme: 'light' | 'dark';
  readonly tokens: MonitorPalette;
  readonly reducedMotion: boolean;
  /** The host's animations switch (the lab's and the catalog's). Off: no loop runs. */
  readonly animations: boolean;
}

/** What the backend lends a view beyond the model (MV-D4). */
export interface MonitorCapabilities {
  /** The desktops and profiles a new terminal can be born under. Absent: a create opens one here at once. */
  readonly spawn?: MonitorSpawnMenu | undefined;
  /** Reserved for history read from rosettad. Nothing provides it yet. */
  readonly history?: never;
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

/** The three commands a view may call (MV-D5). */
export interface MonitorViewCommands {
  /** Show this agent in the active pane. */
  select(agentId: string): void;
  /** Open a terminal: where the gesture happened, and the desktop and profile chosen. */
  create(at?: { readonly x: number; readonly y: number }, target?: MonitorSpawnTarget): void;
  report(report: ViewReport): void;
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
