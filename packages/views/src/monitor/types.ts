import type { MonitorView, MonitorViewKey, MonitorViewMark } from '@vibecook/puppeteer-view-sdk';
import type { AgentMonitorState, MonitorContextState, MonitorRecency } from '@vibecook/puppeteer-core';
import type { AgentVisualStatus } from './agent-status.js';
import type { MonitorParameterGroup } from './parameters.js';

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
 * One monitored session as a host's chrome reads it: the find sheet, the deck's
 * pane frames, the inspector (M19). The monitor views read the SDK's `AgentView`
 * instead (MV-D17); this shape fed them through the legacy shim until MV-8.
 *
 * Agent-ness is a facet rather than a separate variant, so a reader reads
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
  /** Stable spatial identity across a shell-to-agent handoff. Never a runtime/action id. */
  visualId?: string | undefined;
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
   * and labels; it never signals state — with one exception, carried by shape
   * (DESIGN §2.6, TL-D2/D14): the timeline's working span wears it, because
   * there the wake's width says the state (work wide, a wait a thread, rest a
   * hair), so a project hue near orange is never read as blocked. */
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
  /** Finished something while no screen showed it: the backend's word (L5), which the views read from `AgentView`. */
  unread?: boolean | undefined;
  /** The host is showing another group of sessions (VibeField's profile tabs):
   * the row keeps its place — in the physics, in the list — and is drawn
   * faint (`monitor/recede.ts`). Presentation, never a status. */
  receded?: boolean | undefined;
  /** The Agent Profile this row runs under, when the host knows it: a profile
   * SET id (`'native'` for the machine's own). A managed agent's set, or the set
   * a terminal's shell was born under (VibeField binds a pane's shell to it).
   * Absent: unknown, or a shell bound to none. The spawn bloom lights the rows
   * under the profile it points at (SB-D8); a terminal's body names it. */
  profileSet?: string | undefined;
  agent?: MonitorAgentFacet | undefined;
}

/** An Agent Profile the spawn bloom offers under a desktop — a profile SET, in
 * the profile tabs' own terms (`bar/ProfileTabs.tsx` `ProfileTab`), plus who is
 * signed in under it, for the words' detail line. */
export interface MonitorSpawnProfile {
  readonly id: string;
  readonly label: string;
  readonly glyph?: string | undefined;
  readonly kind?: 'native' | 'managed' | undefined;
  /** The desktop's default: letting go on the hub, or on the desktop itself, opens this one. */
  readonly isDefault?: boolean | undefined;
  /** An agent under it waits on the person (the tabs' orange dot). */
  readonly blocked?: boolean | undefined;
  /** The agents signed in under it, as the host labels them, in its order. */
  readonly signedIn?: readonly string[] | undefined;
}

/** Whether a desktop can take a terminal from here right now. Only `ready`
 * takes one; the rest keep their place, faint, and say why (SB-D9). `reading`:
 * ready, but its profiles are not known yet — letting go on it opens its default. */
export type MonitorSpawnDeviceState = 'ready' | 'asleep' | 'silent' | 'incompatible' | 'reading';

/** A desktop the spawn bloom offers: the one you sit at, and peers that can take a terminal from here. */
export interface MonitorSpawnDevice {
  readonly id: string;
  /** Its name. A bud draws its initial (DESIGN §13 has no desktop mark). */
  readonly label: string;
  /** The desktop you are sitting at. */
  readonly self?: boolean | undefined;
  readonly state: MonitorSpawnDeviceState;
  /** The state line under its bud: "2 RUNNING" for a ready peer, "ASLEEP · 2 H" for a faint one. The one you sit at reads HERE. */
  readonly word?: string | undefined;
  /** How the words say a faint desktop cannot take one, after its name: "is asleep". */
  readonly phrase?: string | undefined;
  /** Its Agent Profiles; absent while they are being read. */
  readonly profiles?: readonly MonitorSpawnProfile[] | undefined;
}

/** What a new terminal can be born under. One desktop with one profile is no choice: the hold creates at once. */
export interface MonitorSpawnMenu {
  readonly devices: readonly MonitorSpawnDevice[];
}

/** The desktop and Agent Profile a create asks for. An absent field means the
 * desktop you sit at and its default profile — today's hold. */
export interface MonitorSpawnTarget {
  readonly deviceId?: string | undefined;
  readonly profileSet?: string | undefined;
}

/**
 * A way of looking at the running agents, as the registry lists it: an SDK view (`view`), mounted by the view host
 * (`@vibecook/puppeteer-view-sdk/host`), with the face the host's chrome reads read from its manifest: the id, the
 * label, the mark the bar draws (MV-D6), the keys it prints (MV-D8), the parameter groups the tweak panel offers and
 * the revision they are stored under. Adding one is a folder under `views/` and a line in the registry.
 */
export interface MonitorViewEntry {
  readonly id: string;
  readonly label: string;
  /** The manifest's mark, which the host's bar draws (MV-D6). */
  readonly mark: MonitorViewMark;
  /** The keys the view takes while focused, which the bar prints (MV-D8). */
  readonly keys?: readonly MonitorViewKey[];
  readonly parameterGroups: readonly MonitorParameterGroup[];
  readonly parametersRevision?: string;
  readonly view: MonitorView;
}
