import type { ComponentType } from 'react';
import type {
  AgentMonitorViewDefinition,
  AgentMonitorViewProps as PortableAgentMonitorViewProps,
} from '@vibecook/puppeteer-react';
import type { AgentMonitorState, MonitorContextState, MonitorRecency } from '@vibecook/puppeteer-core';
import type { AgentVisualStatus } from './agent-status.js';
import type { MonitorPalette } from './palette.js';
import type { MonitorParameterGroup, MonitorParameters } from './parameters.js';
import type { UsageHistory } from './usage-ledger.js';

/** The two looks the instrument skin ships; a host keeps the chosen one. */
export type MonitorTheme = 'light' | 'dark';

/**
 * The terminal a row stands for, as much of it as a view reads. A host
 * projects its own session summary onto this (Ghosttea's `SessionSummary` is
 * one such summary and needs no projection: it already has these fields).
 */
export interface MonitorSession {
  id: string;
  createdAtMs: number;
  cwd?: string | null | undefined;
  title?: string | null | undefined;
  /** What the terminal is doing, as its floor reports it; `kind` is the floor's own word. */
  activity?: { kind: string } | null | undefined;
}

/**
 * Which panes show a session, and the colour of the one it is worked in. A
 * pane owns its colour (record §02, revised 2026-09-12); the session wears it
 * while mounted there, as the band and, in the selected pane, the light. The
 * project's colour stays the session's own mark.
 */
export interface PaneAttachment {
  /** The pane the session is worked in: the active pane when it shows this session, else its first pane. */
  primaryPaneId: string;
  /** Every pane showing the session, the primary first, the rest in tree order. */
  paneIds: readonly string[];
  /** The primary pane's colour; absent only for a pane no colour has been dealt to. */
  color?: string | undefined;
}

/** A provider as a view names it: its id, open, and the adapter's own label. */
export interface MonitorProviderRef {
  id: string;
  label: string;
}

/** The agent half of a monitored session; absent while a terminal holds no agent. */
export interface MonitorAgentFacet {
  provider: MonitorProviderRef;
  model?: string | undefined;
  /** Label of the account this run is bound to; absent when it is not registered. */
  account?: string | undefined;
  branch?: string | undefined;
  contextWindow?: MonitorContextState | undefined;
  /** Core's projection for the run. Absent only before the first state has
   * arrived — a host that knows a run exists (it spawned it) but has not heard
   * from its monitor yet shows a starting row rather than inventing a state. */
  monitor?: AgentMonitorState | undefined;
  /** The UI's own account of the tokens (`usage-ledger.ts`): the held total
   * and the burn per step. Views read this, never `monitor.usage`, which is
   * Core's corrected estimate and moves with every source. */
  usage?: UsageHistory | undefined;
  recency: MonitorRecency;
  /** The provider-native session id the host holds for this run, when the
   * monitor has not announced one yet; the find sheet joins on either. */
  nativeSessionId?: string | undefined;
}

/**
 * The peer half of a monitored session: present exactly when the session
 * lives on another machine. Remote-ness is a facet for the same reason
 * agent-ness is — a view reads `remote?.deviceName` rather than re-deriving
 * which kind of thing it holds — and every field here is one the peer itself
 * reported. A host without a mesh never sets it.
 */
export interface MonitorRemoteFacet {
  deviceId: string;
  deviceName: string;
  /** The id ON THE PEER; nothing local may be looked up with it. */
  remoteSessionId: string;
  /** Whether the peer is sharing this session for attachment at all. */
  attachable: boolean;
  /** Whether the HOST permits writes at all; who gets them is decided at attach. */
  hostWritable: boolean;
  /** The peer's own label for its working directory — a label, never a path to resolve. */
  cwdLabel: string | null;
  /** The local replica's session id once this row is attached to a pane here. */
  localSessionId?: string | undefined;
}

/** Where a row's session lives, when a host distinguishes (VibeField's tiers). */
export type MonitorTier = 'managed' | 'ingested' | 'remote';

/**
 * One monitored session in the only shape a view ever sees.
 *
 * Agent-ness is a facet rather than a separate variant, so a view reads
 * `agent?.model` instead of re-deriving which kind of thing it is holding.
 */
export interface MonitorAgent {
  /** Stable when a terminal is promoted to an agent, so view-local placement survives it. */
  id: string;
  /**
   * The local terminal this row stands for; absent for a peer's session,
   * which has none here until it is attached, and for a run whose terminal
   * the host holds no summary of. Optional rather than invented: a view that
   * needs a terminal fact guards for it, and never fills one in.
   */
  session?: MonitorSession | undefined;
  /** When this row was born, from whichever half of it knows. */
  createdAtMs: number;
  remote?: MonitorRemoteFacet | undefined;
  tier?: MonitorTier | undefined;
  status: AgentVisualStatus;
  project: string;
  detail: string;
  /** The project's colour (record §02): the host deals the project a sequence
   * the first time an agent runs in it, and the theme's tint turns that into a
   * hue. A bare terminal belongs to no project and wears the ramp. It groups
   * and labels; it never signals state. */
  color: string;
  /** Evidence recency is presentation metadata, never a fourth status. */
  stale?: boolean | undefined;
  /** Mounted in the pane the user is working in. */
  active: boolean;
  /** The panes showing this session and the colour of the one it is worked
   * in; absent when it is mounted nowhere. A pane owns its colour, and the
   * session wears it while mounted there. */
  attachment?: PaneAttachment | undefined;
  cwd?: string | undefined;
  /** Where the user asked for it, for views that place new arrivals spatially. */
  spawnHint?: { x: number; y: number } | undefined;
  /** Finished something while another pane was active (`monitor/unread.ts`). */
  unread?: boolean | undefined;
  agent?: MonitorAgentFacet | undefined;
}

export interface MonitorActions {
  /** Mount this session in the active pane. */
  select(agent: MonitorAgent): void;
  /** Open a terminal; spatial views pass where the gesture happened. */
  createAt(position?: { x: number; y: number }): void | Promise<void>;
}

export type AgentMonitorProps = PortableAgentMonitorViewProps<MonitorAgent, MonitorActions, MonitorParameters> & {
  /** The live tokens (`palette.ts`). Passed rather than read because two of
   * the three views paint into a canvas, which cannot inherit a custom
   * property — and a view that resolved its own would be a second reader of
   * the design system with its own idea of when to re-read it. */
  readonly palette: MonitorPalette;
};

/**
 * A way of looking at the running agents. Adding one is a file plus a line in
 * the registry — deliberately the same shape as adding a built-in provider in
 * `packages/builtin-providers`.
 *
 * A view is a pure function of these props. It never reaches the runtime, the
 * workspace, a terminal or a daemon, which is what keeps it structurally
 * unable to break the invariant that semantics never come from terminal text
 * (DESIGN ADR-003) and what lets two hosts mount the same view.
 */
export interface AgentMonitorView extends Omit<
  AgentMonitorViewDefinition<MonitorAgent, MonitorActions, MonitorParameters>,
  'Component'
> {
  readonly parameterGroups: readonly MonitorParameterGroup[];
  /** Set when a view's defaults were re-decided: the tunables are stored under
   * the revision, so every installation lands on the new defaults instead of
   * keeping the values the old design had saved. Later tunes persist as before. */
  readonly parametersRevision?: string;
  /** The portable contract's component, plus the palette the shell resolves for it. */
  readonly Component: ComponentType<AgentMonitorProps>;
}
