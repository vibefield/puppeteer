import {
  compareMonitorRows,
  type AgentView,
  type FrameScheduler,
  type ModelChanges,
  type MonitorAgentRow,
  type MonitorModel,
  type MonitorModelChange,
  type MonitorModelSnapshot,
  type MonitorSpawnMenu,
  type MonitorActivity,
} from '@vibefield/puppeteer-view-sdk/model';
import { classifyTerminalStatus } from '../terminal-status.js';
import { freezeJson, sameJson } from './json.js';

/**
 * The window replica (MV-1b): the model's consumer edge, one per window.
 *
 * The backend computes every business fact once, beside the runtime, and the
 * sync plane carries its model as snapshots and changes. A replica applies
 * them along the revision chain, joins what only this window knows (its
 * panes, the active pane, receding, spawn hints) and the theme's colour (L7),
 * and hands the view host the contract's `MonitorModel`. It computes no
 * business fact.
 *
 * Identity is the contract (MV-D21): an unchanged row keeps its `AgentView`,
 * `model` keeps its identity while nothing in it changed, and subscribers hear
 * at most once a frame. Every view caches on identity, which is what keeps a
 * frame cheap. Browser-safe: it touches no DOM, and its frame is injectable.
 */

/** A row's panes in this window: how many show it, and the colour of the one it is worked in. */
export interface MonitorReplicaAttachment {
  readonly panes: number;
  readonly colour?: string | undefined;
}

/**
 * What only this window knows, by row id. The host replaces it whole (never
 * mutate the collections it holds), and the replica re-joins only the rows
 * whose facts moved.
 */
export interface MonitorReplicaLocal {
  readonly attachments: ReadonlyMap<string, MonitorReplicaAttachment>;
  /** The rows mounted in the pane the person is working in. */
  readonly activeIds: ReadonlySet<string>;
  /** The host is showing another group (VibeField's profile tabs). A new predicate is asked of every row again. */
  readonly receded?: ((row: MonitorAgentRow) => boolean) | undefined;
  /**
   * Which rows this window shows at all (M3): the model carries ended runs, and
   * VibeField passes `row => row.alive`. A hidden row is absent from the model,
   * hiding and showing read as removed and added, and a row shown again with
   * nothing changed comes back as the same object. A new predicate is asked of
   * every row again.
   */
  readonly visible?: ((row: MonitorAgentRow) => boolean) | undefined;
  /** Where the person asked for each row, for views that place new arrivals spatially. */
  readonly spawnHints: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  /**
   * What each bare terminal is doing, as only this window knows it (M28): the
   * window's panes hear it from the terminal renderer, while the host's floor
   * knows a PTY's cwd and title but not its activity. Terminal rows only; an
   * agent's activity is the runtime's and is never replaced. Absent entry: the
   * row's own. A joined activity also decides the terminal's status, by the
   * backend's own rule (`classifyTerminalStatus`): a foreground job works.
   */
  readonly activity?: ReadonlyMap<string, MonitorActivity> | undefined;
  /**
   * Each row's spatial identity, as only this window knows it (M59): a launcher's agent takes the shell's place, so a
   * spatial view keeps one body across the handoff. Keyed by row id; an absent entry leaves the row without one, and a
   * view reads `visualId ?? id`. Puppeteer's Godview computes it with `visualIdsForRows`.
   */
  readonly visualIds?: ReadonlyMap<string, string> | undefined;
}

/** The theme's colour function (L7). The same `key` promises the same colours, so only a new key re-colours. */
export interface MonitorReplicaTheme {
  readonly key: string;
  /** A project's colour from its sequence; no sequence: the neutral ramp. */
  colourFor(seq?: number): string;
}

export interface CreateMonitorReplicaOptions {
  /**
   * The host's ONE frame scheduler, the same instance its view host's slot uses
   * (M7). Work requested while a frame drains joins that frame, so the slot's
   * update lands in the frame this replica's notification ran in. Default:
   * `requestAnimationFrame` where there is one, else a 16 ms timer.
   */
  scheduler?: FrameScheduler;
  /**
   * How many changes heard during a gap are held for the snapshot that heals it (M22). Past it the held changes are
   * dropped and the replica waits for the snapshot alone. Default `DEFAULT_GAP_BUFFER`.
   */
  gapBuffer?: number;
  /** Hears what a listener or a host callback threw; nothing a host passes in can stop a publication. */
  onListenerError?: (error: unknown) => void;
  /** The clock a window-joined status flip is stamped by when its activity carries no `since` (M28). Default `Date.now`. */
  now?: () => number;
}

/**
 * The changes a gap holds by default: the backend emits at most one change a tick, and a snapshot's round trip is
 * a moment, so this is generous; it bounds what a gap that never heals can hold.
 */
export const DEFAULT_GAP_BUFFER = 256;

/** What a replica publishes: stable until the next publication, at most once a frame. */
export interface MonitorReplicaSnapshot {
  /** `model.revision` is the backend revision its rows were last read at. */
  readonly model: MonitorModel;
  /** What moved between the previous publication's model and this one's. */
  readonly changes: ModelChanges;
  /** The backend's spawn menu (capability `spawn`, MV-D4); absent while the backend offers none. */
  readonly spawn?: MonitorSpawnMenu | undefined;
}

export interface MonitorReplica {
  /**
   * A snapshot replaces the model whole. A change applies on top of the held
   * revision only: one whose `since` is not it is a gap, so it is not applied
   * and `onGap` asks the host for a snapshot. Changes heard during the gap are
   * held (bounded), and the snapshot that heals it replays those whose `since`
   * is at or after its revision, in order: a change that arrives before its
   * snapshot is not lost (M22). False: nothing was applied.
   */
  apply(update: MonitorModelSnapshot | MonitorModelChange): boolean;
  /** Heard once each time the chain breaks; changes are held, not applied, until the next snapshot. */
  onGap(listener: () => void): () => void;
  setLocal(local: MonitorReplicaLocal): void;
  setTheme(theme: MonitorReplicaTheme): void;
  getSnapshot(): MonitorReplicaSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

/** The colour a row wears before the host sets a theme: a rendering with no colour rather than an invented one. */
export const NO_THEME_COLOUR = 'currentColor';

const NO_IDS: readonly string[] = Object.freeze([]);
const NO_CHANGES: ModelChanges = Object.freeze({ added: NO_IDS, updated: NO_IDS, removed: NO_IDS });
const NO_LOCAL: MonitorReplicaLocal = Object.freeze({
  attachments: new Map<string, MonitorReplicaAttachment>(),
  activeIds: new Set<string>(),
  spawnHints: new Map<string, { readonly x: number; readonly y: number }>(),
});

interface Joined {
  readonly row: MonitorAgentRow;
  readonly view: AgentView;
}

/** A browser's frame, reached narrowly: this package compiles without the DOM (M8), and Node has no frame. */
const frameGlobals = globalThis as typeof globalThis & {
  readonly requestAnimationFrame?: (callback: () => void) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
};

/**
 * The frame when a host passes none: requestAnimationFrame where there is one,
 * else a 16 ms timer. It needs no draining queue: it is this replica's own, and
 * its one task is the only work on it, so "joins the draining frame" never
 * arises, and the task asked again from inside its own run waits for the next
 * frame, as the interface says.
 */
function frameScheduler(): FrameScheduler {
  const { requestAnimationFrame, cancelAnimationFrame } = frameGlobals;
  if (typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function') {
    return {
      request(work) {
        const handle = requestAnimationFrame.call(globalThis, () => work());
        return () => cancelAnimationFrame.call(globalThis, handle);
      },
    };
  }
  return {
    request(work) {
      const handle = setTimeout(work, 16);
      return () => clearTimeout(handle);
    },
  };
}

/** The ids of `views` that are in `ids`, in the views' order. */
function idsIn(views: readonly AgentView[], ids: ReadonlySet<string>): readonly string[] {
  if (ids.size === 0) return NO_IDS;
  return Object.freeze(views.filter((view) => ids.has(view.id)).map((view) => view.id));
}

export function createMonitorReplica(options: CreateMonitorReplicaOptions = {}): MonitorReplica {
  const scheduler = options.scheduler ?? frameScheduler();
  const gapBuffer = options.gapBuffer ?? DEFAULT_GAP_BUFFER;
  if (!Number.isSafeInteger(gapBuffer) || gapBuffer < 0) {
    throw new RangeError('gapBuffer must be a safe integer, zero or more');
  }
  /** The backend's rows at the held revision, frozen. */
  const rows = new Map<string, MonitorAgentRow>();
  /** The published views and the rows they were joined from. Changed only when a frame publishes. */
  const joined = new Map<string, Joined>();
  /** The last published view of each row the host hides now, kept while the row lives so it can come back as itself. */
  const hidden = new Map<string, Joined>();
  /** Rows whose view may differ from the published one. */
  const dirty = new Set<string>();
  /** Colours by project sequence under the current theme key. */
  const colours = new Map<number | undefined, string>();
  /** A window-joined terminal status that differs from the backend's, and since when (M28). */
  const terminalClock = new Map<string, { readonly status: AgentView['status']; readonly since: number }>();
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  const gapListeners = new Set<() => void>();
  let revision: number | undefined;
  let gapped = false;
  /** The changes heard since the chain broke, for the snapshot that heals it; dropped whole past `gapBuffer`. */
  let held: MonitorModelChange[] = [];
  let overflowed = false;
  /** A row's place in the order may have moved (its kind or birth changed). */
  let reorder = false;
  let spawn: MonitorSpawnMenu | undefined;
  let local = NO_LOCAL;
  let theme: MonitorReplicaTheme | undefined;
  let published: MonitorReplicaSnapshot = Object.freeze({
    model: Object.freeze({ revision: 0, agents: Object.freeze([]), byId: new Map<string, AgentView>() }),
    changes: NO_CHANGES,
  });
  let framePending = false;
  let cancelFrame: (() => void) | undefined;
  let disposed = false;

  const report = (error: unknown): void => {
    try {
      options.onListenerError?.(error);
    } catch {
      // A diagnostic hook is still a listener; it cannot interrupt publication.
    }
  };

  const call = (listener: () => void): void => {
    try {
      listener();
    } catch (error) {
      report(error);
    }
  };

  const colourOf = (seq: number | undefined): string => {
    if (!theme) return NO_THEME_COLOUR;
    const held = colours.get(seq);
    if (held !== undefined) return held;
    try {
      const colour = theme.colourFor(seq);
      colours.set(seq, colour);
      return colour;
    } catch (error) {
      report(error);
      return NO_THEME_COLOUR;
    }
  };

  const recededOf = (row: MonitorAgentRow): boolean => {
    const receded = local.receded;
    if (!receded) return false;
    try {
      return receded(row) === true;
    } catch (error) {
      report(error);
      return false;
    }
  };

  const visibleOf = (row: MonitorAgentRow): boolean => {
    const visible = local.visible;
    if (!visible) return true;
    try {
      return visible(row) !== false;
    } catch (error) {
      report(error);
      return true;
    }
  };

  const attachmentOf = (id: string, held: AgentView['attachment']): AgentView['attachment'] => {
    const entry = local.attachments.get(id);
    if (!entry) return undefined;
    if (held && held.panes === entry.panes && held.colour === entry.colour) return held;
    return Object.freeze(
      entry.colour === undefined ? { panes: entry.panes } : { panes: entry.panes, colour: entry.colour },
    );
  };

  const spawnHintOf = (id: string, held: AgentView['spawnHint']): AgentView['spawnHint'] => {
    const entry = local.spawnHints.get(id);
    if (!entry) return undefined;
    if (held && held.x === entry.x && held.y === entry.y) return held;
    return Object.freeze({ x: entry.x, y: entry.y });
  };

  /** A terminal's activity from this window's panes when it has one, else the row's own (M28). */
  const activityOf = (row: MonitorAgentRow, held: AgentView['activity']): AgentView['activity'] => {
    if (row.kind !== 'terminal') return row.activity;
    const entry = local.activity?.get(row.id);
    if (!entry) return row.activity;
    if (held && held.kind === entry.kind && held.line === entry.line && held.since === entry.since) return held;
    return Object.freeze({
      kind: entry.kind,
      ...(entry.line === undefined ? {} : { line: entry.line }),
      ...(entry.since === undefined ? {} : { since: entry.since }),
    });
  };

  /**
   * A terminal whose activity the window joined reads the status that activity means (M28), on its own clock: stamped
   * when the joined status first differs from the backend's (the activity's own `since` when it has one), kept while it
   * holds, and dropped when the backend's status agrees again or the window's entry goes.
   */
  const statusOf = (
    row: MonitorAgentRow,
    activity: AgentView['activity'],
  ): { readonly status: AgentView['status']; readonly statusSince: number } => {
    if (row.kind !== 'terminal' || local.activity?.has(row.id) !== true) {
      terminalClock.delete(row.id);
      return { status: row.status, statusSince: row.statusSince };
    }
    const status = classifyTerminalStatus(activity);
    if (status === row.status) {
      terminalClock.delete(row.id);
      return { status, statusSince: row.statusSince };
    }
    let clock = terminalClock.get(row.id);
    if (!clock || clock.status !== status) {
      clock = { status, since: activity?.since ?? now() };
      terminalClock.set(row.id, clock);
    }
    return { status, statusSince: clock.since };
  };

  /** The row joined with this window's facts: the published view itself when none of them moved. */
  const join = (row: MonitorAgentRow, held: Joined | undefined): AgentView => {
    const previous = held?.view;
    const colour = colourOf(row.project.seq);
    const active = local.activeIds.has(row.id);
    const receded = recededOf(row);
    const attachment = attachmentOf(row.id, previous?.attachment);
    const spawnHint = spawnHintOf(row.id, previous?.spawnHint);
    const activity = activityOf(row, previous?.activity);
    const { status, statusSince } = statusOf(row, activity);
    const visualId = local.visualIds?.get(row.id);
    if (
      previous !== undefined &&
      held?.row === row &&
      previous.colour === colour &&
      previous.active === active &&
      previous.receded === receded &&
      previous.attachment === attachment &&
      previous.spawnHint === spawnHint &&
      previous.activity === activity &&
      previous.status === status &&
      previous.statusSince === statusSince &&
      previous.visualId === visualId
    ) {
      return previous;
    }
    return Object.freeze({
      ...row,
      status,
      statusSince,
      colour,
      active,
      receded,
      ...(attachment ? { attachment } : {}),
      ...(spawnHint ? { spawnHint } : {}),
      ...(activity ? { activity } : {}),
      ...(visualId === undefined ? {} : { visualId }),
    });
  };

  const flush = (): void => {
    if (disposed) return;
    // Computed aside and committed at the end, so the published state never holds half a frame.
    const updates = new Map<string, Joined | undefined>();
    const gone: string[] = [];
    for (const id of dirty) {
      const row = rows.get(id);
      const held = joined.get(id);
      if (!row || !visibleOf(row)) {
        if (!row) gone.push(id);
        if (held) updates.set(id, undefined);
        continue;
      }
      const view = join(row, held ?? hidden.get(id));
      if (view !== held?.view) updates.set(id, { row, view });
    }
    dirty.clear();
    for (const id of gone) {
      hidden.delete(id);
      terminalClock.delete(id);
    }

    let model = published.model;
    let changes = NO_CHANGES;
    if (updates.size > 0) {
      const added = new Set<string>();
      const updated = new Set<string>();
      const removed = new Set<string>();
      for (const [id, next] of updates) {
        const held = joined.get(id);
        if (!next) {
          joined.delete(id);
          removed.add(id);
          // Hidden rather than gone: kept, so it can come back as itself.
          if (held && rows.has(id)) hidden.set(id, held);
          continue;
        }
        (held ? updated : added).add(id);
        joined.set(id, next);
        hidden.delete(id);
      }
      const views =
        reorder || added.size > 0 || removed.size > 0
          ? [...joined.values()].map((entry) => entry.view).sort(compareMonitorRows)
          : published.model.agents.map((view) => joined.get(view.id)?.view ?? view);
      reorder = false;
      model = Object.freeze({
        revision: revision ?? 0,
        agents: Object.freeze(views),
        byId: new Map(views.map((view) => [view.id, view] as const)),
      });
      changes = Object.freeze({
        added: idsIn(views, added),
        updated: idsIn(views, updated),
        removed: idsIn(published.model.agents, removed),
      });
    }
    if (model === published.model && spawn === published.spawn) return;
    published = Object.freeze({ model, changes, ...(spawn ? { spawn } : {}) });
    for (const listener of [...listeners]) call(listener);
  };

  /**
   * The one task this replica asks of its scheduler, one request a frame. It is
   * always the same function, and a scheduler runs a task at most once a frame,
   * so a change a listener makes while it runs is heard in the next frame.
   */
  const runFrame = (): void => {
    framePending = false;
    cancelFrame = undefined;
    flush();
  };

  const schedule = (): void => {
    if (disposed || framePending || (dirty.size === 0 && spawn === published.spawn)) return;
    framePending = true;
    const cancel = scheduler.request(runFrame);
    // A scheduler may run the frame before it returns; then there is nothing left to cancel.
    if (framePending) cancelFrame = cancel;
  };

  const take = (incoming: MonitorAgentRow): void => {
    const held = rows.get(incoming.id);
    if (held !== undefined && (held === incoming || sameJson(held, incoming))) return;
    // Back to what is published (a flip within one frame): the published row keeps its view.
    const shown = joined.get(incoming.id)?.row;
    const row = shown !== undefined && shown !== held && sameJson(shown, incoming) ? shown : freezeJson(incoming);
    const before = held ?? shown;
    if (before !== undefined && (before.kind !== row.kind || before.createdAt !== row.createdAt)) reorder = true;
    rows.set(row.id, row);
    dirty.add(row.id);
  };

  const takeSpawn = (next: MonitorSpawnMenu | undefined): void => {
    if (next === undefined) {
      spawn = undefined;
      return;
    }
    if (spawn !== undefined && (spawn === next || sameJson(spawn, next))) return;
    spawn = published.spawn !== undefined && sameJson(published.spawn, next) ? published.spawn : freezeJson(next);
  };

  const gap = (): void => {
    if (gapped) return;
    gapped = true;
    for (const listener of [...gapListeners]) call(listener);
  };

  /** Held for the healing snapshot; past the bound everything held goes, and the snapshot alone heals, as before. */
  const hold = (update: MonitorModelChange): void => {
    if (overflowed) return;
    if (held.length >= gapBuffer) {
      held = [];
      overflowed = true;
      return;
    }
    held.push(update);
  };

  /** A change on the chain applies; off it, or while the chain is broken, it is held and the gap heard once. */
  const applyChange = (update: MonitorModelChange): boolean => {
    if (!gapped && (revision === undefined || update.since !== revision)) gap();
    if (gapped) {
      hold(update);
      return false;
    }
    revision = update.revision;
    for (const row of update.upserts) take(row);
    for (const id of update.removed) {
      if (rows.delete(id)) dirty.add(id);
    }
    if (update.spawn !== undefined) takeSpawn(update.spawn);
    return true;
  };

  return {
    apply(update) {
      if (disposed) return false;
      if ('rows' in update) {
        revision = update.revision;
        gapped = false;
        const present = new Set<string>();
        for (const row of update.rows) {
          present.add(row.id);
          take(row);
        }
        for (const id of [...rows.keys()]) {
          if (present.has(id)) continue;
          rows.delete(id);
          dirty.add(id);
        }
        takeSpawn(update.spawn);
        // The changes heard during the gap that the snapshot does not hold, in order; a link missing among them is
        // a new gap, and what follows it is held for the next snapshot.
        const replay = held.filter((change) => change.since >= update.revision);
        held = [];
        overflowed = false;
        for (const change of replay) applyChange(change);
      } else if (!applyChange(update)) {
        return false;
      }
      schedule();
      return true;
    },
    onGap(listener) {
      gapListeners.add(listener);
      return () => gapListeners.delete(listener);
    },
    setLocal(next) {
      if (disposed || next === local) return;
      const previous = local;
      local = next;
      // A row not held yet is joined with these facts when it arrives.
      const touch = (id: string): void => {
        if (rows.has(id)) dirty.add(id);
      };
      for (const [id, entry] of next.attachments) {
        const held = previous.attachments.get(id);
        if (!held || held.panes !== entry.panes || held.colour !== entry.colour) touch(id);
      }
      for (const id of previous.attachments.keys()) if (!next.attachments.has(id)) touch(id);
      for (const id of next.activeIds) if (!previous.activeIds.has(id)) touch(id);
      for (const id of previous.activeIds) if (!next.activeIds.has(id)) touch(id);
      for (const [id, entry] of next.spawnHints) {
        const held = previous.spawnHints.get(id);
        if (!held || held.x !== entry.x || held.y !== entry.y) touch(id);
      }
      for (const id of previous.spawnHints.keys()) if (!next.spawnHints.has(id)) touch(id);
      if (next.activity !== previous.activity) {
        const before = previous.activity;
        const after = next.activity;
        if (after) {
          for (const [id, entry] of after) {
            const held = before?.get(id);
            if (!held || held.kind !== entry.kind || held.line !== entry.line || held.since !== entry.since) touch(id);
          }
        }
        if (before) for (const id of before.keys()) if (!after?.has(id)) touch(id);
      }
      if (next.visualIds !== previous.visualIds) {
        const before = previous.visualIds;
        const after = next.visualIds;
        if (after) for (const [id, visualId] of after) if (before?.get(id) !== visualId) touch(id);
        if (before) for (const id of before.keys()) if (!after?.has(id)) touch(id);
      }
      if (next.receded !== previous.receded || next.visible !== previous.visible) {
        for (const id of rows.keys()) dirty.add(id);
      }
      schedule();
    },
    setTheme(next) {
      if (disposed) return;
      const key = theme?.key;
      theme = next;
      if (key === next.key) return;
      colours.clear();
      for (const id of rows.keys()) dirty.add(id);
      schedule();
    },
    getSnapshot: () => published,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      cancelFrame?.();
      cancelFrame = undefined;
      framePending = false;
      listeners.clear();
      gapListeners.clear();
    },
  };
}
