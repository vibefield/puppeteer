/**
 * The monitor model: what the backend knows about every agent, as plain data.
 *
 * One backend per desktop computes every business fact once, beside the runtime
 * (MV-D22). The sync plane carries this model and nothing view-shaped. Each
 * screen holds a replica, and a view draws the replica (`./view.ts`).
 *
 * Nothing here may reference the DOM, React, a runtime, a transport or a host:
 * the model crosses processes and devices as JSON, and the backend imports this
 * file from Node. Every timestamp is epoch milliseconds.
 */

/** A run's state. Evidence recency is never a fourth state: see `MonitorAgentRow.stale`. */
export type AgentStatus = 'idle' | 'working' | 'blocked';

/** What a row stands for: a run the runtime monitors, or a terminal no agent runs in yet. */
export type AgentRowKind = 'agent' | 'terminal';

/** How the desktop holds the row: a run it manages, one it ingested, or one on another desktop. */
export type AgentTier = 'managed' | 'ingested' | 'remote';

/** The OS mark a device is drawn by. Devices are marks, never names, in a row. */
export type DeviceOs = 'mac' | 'windows' | 'linux' | 'ios' | 'android';

/** A fixed-bucket series, oldest first. */
export interface MonitorSeries {
  readonly stepMs: number;
  /** Bucket values, oldest first. The last is the current bucket, still filling. */
  readonly steps: readonly number[];
  /** When the last bucket began, so a view can align the series of different rows. */
  readonly lastStepAt: number;
}

export interface MonitorDeviceRef {
  readonly id: string;
  readonly name: string;
  readonly os?: DeviceOs | undefined;
  /** The desktop this model is read on. */
  readonly self: boolean;
}

/** What a blocked run waits on: the first blocker, as far as the reader's cut carries it.
 * The parts stay separate because views word them in their own order (the
 * swarm's body: header or prompt, then detail, then tool, then code; the
 * timeline's lane: detail, then prompt). */
export interface MonitorWait {
  /** The runtime's own word, open: `permission`, `question`, `failure`, … */
  readonly kind: string;
  readonly since: number;
  /** How many blockers wait, counted before any bound; this one is the first. Absent: one. */
  readonly count?: number | undefined;
  /** A permission's tool. */
  readonly tool?: string | undefined;
  /** A failure's code. */
  readonly code?: string | undefined;
  /** A question's header, bounded. Absent on a cut that carries no content (the phone's). */
  readonly header?: string | undefined;
  /** A question's prompt, bounded. Absent on a cut that carries no content. */
  readonly question?: string | undefined;
  /** The blocker's own detail line, in the adapter's words, bounded. Absent on a cut that carries no content. */
  readonly detail?: string | undefined;
}

export interface MonitorActivity {
  readonly kind: string;
  readonly line?: string | undefined;
  readonly since?: number | undefined;
}

/** The effort a run works at, and whether that is the provider's evidence or only the launch's intent. */
export interface MonitorEffort {
  readonly value: string;
  readonly intent?: 'configured' | 'observed' | undefined;
}

/** The run's latest reply, bounded. Absent on a cut that carries no content. */
export interface MonitorReply {
  readonly text: string;
  readonly at?: number | undefined;
  /** False while the reply is still streaming. */
  readonly final?: boolean | undefined;
}

/** How much of the observed work was priced: puppeteer's own word. */
export type CostCoverage = 'complete' | 'partial' | 'unavailable';

export interface MonitorCost {
  /** Estimated API-equivalent USD for observed work, never an invoice. */
  readonly usd: number;
  readonly coverage: CostCoverage;
  /** USD an hour, at the backend's current burn. */
  readonly burnPerHour?: number | undefined;
  /** USD per step over the recent window (today 20 × 30 s). */
  readonly series?: MonitorSeries | undefined;
}

export interface MonitorTokens {
  readonly total?: number | undefined;
  readonly perMinute?: number | undefined;
}

export interface MonitorProject {
  /** A folder NAME, never a path (EL7 B1). Empty for a terminal in no project. */
  readonly name: string;
  /** Absent: nothing looked. Null: looked, and there is no branch. */
  readonly branch?: string | null | undefined;
  /** The project's colour sequence, dealt the first time an agent runs in it.
   * The view host turns it into a colour with the theme; absent wears the
   * neutral ramp. */
  readonly seq?: number | undefined;
}

/**
 * One row of the model: everything a screen may draw about one agent or bare
 * terminal, computed by the backend.
 *
 * Presentation-free. There is no colour here (the view host derives it from
 * `project.seq` and the theme), and nothing only one window knows (attachment,
 * the active pane, receding, spawn hints): the replica joins those into
 * `AgentView`.
 */
export interface MonitorAgentRow {
  /** Stable identity. It survives a terminal being promoted to an agent and a
   * run resuming in a new terminal, so a view keys by this and nothing else. */
  readonly id: string;
  readonly kind: AgentRowKind;
  /** When the row was born, from whichever half of it knows. */
  readonly createdAt: number;
  readonly status: AgentStatus;
  /** When the current status began. */
  readonly statusSince: number;
  /** Not heard from lately. Presentation metadata, never a status. */
  readonly stale: boolean;
  /** Still there: the host's liveness, or the runtime's own word. */
  readonly alive: boolean;
  /** The runtime has reported a state for this run. False while it starts, and while nothing drives it (with
   * `pending`). A terminal is always observed, by its host. */
  readonly observed: boolean;
  /** Alive, but nothing drives it yet (a run that resumes at its next idle). */
  readonly pending?: boolean | undefined;
  /** The line under the name, in the backend's words (the toolkit holds the shared words, MV-D11). */
  readonly detail: string;
  /** What the row is doing now. An agent: the runtime's activity kind
   * (`starting`, `responding`, `reasoning`, `tool`, `delegating`, `compacting`,
   * `other`) and its line, bounded (absent on a cut that carries no content). A
   * terminal: its session's activity kind, and no line. */
  readonly activity?: MonitorActivity | undefined;
  readonly project: MonitorProject;
  readonly provider?: { readonly id: string; readonly label: string } | undefined;
  readonly model?: string | undefined;
  readonly effort?: MonitorEffort | undefined;
  readonly account?: string | undefined;
  readonly context?: { readonly usedPercent: number } | undefined;
  readonly wait?: MonitorWait | undefined;
  readonly reply?: MonitorReply | undefined;
  readonly cost?: MonitorCost | undefined;
  readonly tokens?: MonitorTokens | undefined;
  /** A finished turn nobody has looked at yet: the backend's mark, cleared when any screen shows it. */
  readonly unread: boolean;
  readonly device: MonitorDeviceRef;
  readonly tier?: AgentTier | undefined;
  /** The Agent Profile SET it runs under (`native` for the machine's own). */
  readonly profileSet?: string | undefined;
  /** A pane on the reading desktop can show it now. */
  readonly attachable: boolean;
  /**
   * Whether a pane on another desktop may type into this run, by its home desktop's policy (M41). The home backend
   * computes it once; today it equals `attachable`. A view reads it only for a row from another desktop
   * (`device.self` false): the list's host chip and the swarm's host line. No view derives write policy itself.
   */
  readonly writable: boolean;
}

/** An Agent Profile the spawn bloom offers under a desktop. */
export interface MonitorSpawnProfile {
  readonly id: string;
  readonly label: string;
  readonly glyph?: string | undefined;
  readonly kind?: 'native' | 'managed' | undefined;
  /** The desktop's default: letting go on the desktop itself opens this one. */
  readonly isDefault?: boolean | undefined;
  /** An agent under it waits on the person. */
  readonly blocked?: boolean | undefined;
  /** The agents signed in under it, in the host's order. */
  readonly signedIn?: readonly string[] | undefined;
}

/** Whether a desktop can take a terminal right now. Only `ready` takes one. */
export type MonitorSpawnDeviceState = 'ready' | 'asleep' | 'silent' | 'incompatible' | 'reading';

/** A desktop a new terminal can be born on. */
export interface MonitorSpawnDevice {
  readonly id: string;
  readonly label: string;
  readonly self?: boolean | undefined;
  readonly state: MonitorSpawnDeviceState;
  /** The state line under its bud, worded by the backend. */
  readonly word?: string | undefined;
  /** How the words say a faint desktop cannot take one, after its name. */
  readonly phrase?: string | undefined;
  /** Absent while they are being read. */
  readonly profiles?: readonly MonitorSpawnProfile[] | undefined;
}

/** What a new terminal can be born under (capability `spawn`, MV-D4). */
export interface MonitorSpawnMenu {
  readonly devices: readonly MonitorSpawnDevice[];
}

/** The desktop and profile a create asks for. Absent fields: this desktop, its default profile. */
export interface MonitorSpawnTarget {
  readonly deviceId?: string | undefined;
  readonly profileSet?: string | undefined;
}

/**
 * The whole model at one revision.
 *
 * Rows are in the model's order: agents by birth, then bare terminals, ties by
 * id. An unchanged row keeps its object from one snapshot to the next (MV-D21).
 */
export interface MonitorModelSnapshot {
  readonly revision: number;
  readonly rows: readonly MonitorAgentRow[];
  readonly spawn?: MonitorSpawnMenu | undefined;
}

/**
 * What changed between two revisions.
 *
 * It applies on top of `since`. A reader whose revision is not `since` has lost
 * a change and asks for a snapshot: the tolerant reader's rule, never an ack
 * protocol. An idle model emits nothing.
 */
export interface MonitorModelChange {
  readonly since: number;
  readonly revision: number;
  readonly upserts: readonly MonitorAgentRow[];
  readonly removed: readonly string[];
  /** Present only when the spawn menu changed. */
  readonly spawn?: MonitorSpawnMenu | undefined;
}

/* The record's past (capability `history`, MV-D4). Read from rosettad by the backend at each ask, joined with the
 * model there, and held nowhere: the backend still keeps live state only. Never a row of the model and never synced
 * per row; a screen asks for it while a view that declares it is mounted. Only this runtime's runs: a session the
 * record holds that this runtime never ran is no lane. */

/**
 * What a stretch of a lane's past was, as the record can say it. Never blocked and never unseen: a transcript does
 * not record a permission wait or a person's glance.
 *
 * - `worked`: inside a turn.
 * - `quiet`: between turns.
 * - `unrecorded`: a silence longer than the backend's cut (15 min) inside a turn. The record cannot say whether the
 *   agent worked or waited there.
 * - `bounds`: the record's bounds alone (the floor, or one session whose turns were not read). Activity was recorded
 *   between them, and what it was inside is unknown: drawn flat and faint, never counted as work.
 *
 * Time inside a lane's life that no span covers is not recorded; before its birth a lane is unborn.
 */
export type MonitorPastSpanKind = 'worked' | 'quiet' | 'unrecorded' | 'bounds';

export interface MonitorPastSpan {
  readonly kind: MonitorPastSpanKind;
  /** Epoch ms, inside the window asked. */
  readonly from: number;
  readonly to: number;
}

/**
 * A row's past before the runtime took over: what the record says it did until its current status began. A live lane
 * is born at the earlier of its row's `createdAt` and its first span (a resumed session's record starts before its run).
 */
export interface MonitorLivePast {
  /** The model row it belongs to. */
  readonly id: string;
  /** The row's `statusSince` when the past was read. A view clips to the row's CURRENT `statusSince` too. */
  readonly seamAt: number;
  /** Oldest first, never overlapping, all before `seamAt`. */
  readonly spans: readonly MonitorPastSpan[];
}

/** A run this runtime ran that the model no longer holds, with its record in the window. */
export interface MonitorEndedRow {
  /**
   * `past:<provider>:<native session id>`, never a model row's id, and never sent to the backend (a view may hand it
   * to its host's `openEnded`, TV-8).
   */
  readonly id: string;
  readonly provider?: { readonly id: string; readonly label: string } | undefined;
  /** The session's title for the name column (the record's); absent: the view names it by provider · project. */
  readonly title?: string | undefined;
  /** The Agent Profile SET it ran under, when the host knew it: what a profile filter reads. */
  readonly profileSet?: string | undefined;
  /** A folder name and its colour's sequence, as a live row's. */
  readonly project: MonitorProject;
  readonly device: MonitorDeviceRef;
  /** Its birth: when the record began. */
  readonly startedAt: number;
  /** Its last recorded activity (not an exit: the record holds no exit). */
  readonly endedAt: number;
  /** Oldest first, never overlapping. */
  readonly spans: readonly MonitorPastSpan[];
}

/**
 * The past of one window of time, as the backend derived it from the record. `fidelity` says how fine it is:
 * `turns` from the record's turns, `bounds` from each session's first and last activity alone (ended runs only, one
 * `bounds` span each; live rows' past stays unrecorded). There is no cap: a backend that drops sessions says
 * `partial`, with a detail.
 */
export interface MonitorPastSnapshot {
  /** The window read, epoch ms; at most a day. */
  readonly sinceMs: number;
  readonly untilMs: number;
  /** When the backend read it. */
  readonly readAt: number;
  readonly fidelity: 'turns' | 'bounds';
  /**
   * `partial`: some of the record could not be read (or a re-read failed, and this is the last good one);
   * `unavailable`: a record should be here and cannot be read now. `detail` says why, in one sentence.
   */
  readonly state: 'complete' | 'partial' | 'unavailable';
  readonly detail?: string | undefined;
  readonly live: readonly MonitorLivePast[];
  /** In birth order. */
  readonly ended: readonly MonitorEndedRow[];
}

/** Orders rows the way every snapshot does: agents by birth, then terminals, ties by id. */
export function compareMonitorRows(a: MonitorAgentRow, b: MonitorAgentRow): number {
  if (a.kind !== b.kind) return a.kind === 'agent' ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Batches work into frames. The replica's notifications and the view host's
 * updates share ONE instance so their batches coincide: work requested while a
 * frame is draining runs in that same frame (unless that task already ran in
 * it), so a model change reaches the view in the frame it arrived in, never one
 * later. `request` returns a cancel.
 */
export interface FrameScheduler {
  request(work: () => void): () => void;
}

/* What a view draws: the replica's join of the model with one window's own facts. Still plain
 * data (no DOM), so the replica imports it from `./model` (L3). */

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
  /**
   * The body this row continues, when its window knows it (window-local: the replica's `setLocal({ visualIds })`).
   * A launcher's agent takes the shell's place in its pane, so a spatial view keeps ONE body across the handoff
   * instead of a removal and an arrival. Absent: the row's own id. A view keys spatial identity by `visualId ?? id`.
   */
  readonly visualId?: string | undefined;
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
