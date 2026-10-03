import {
  compareMonitorRows,
  type AgentView,
  type ModelChanges,
  type MonitorAgentRow,
  type MonitorModel,
  type MonitorModelChange,
  type MonitorModelSnapshot,
  type MonitorSpawnMenu,
} from '@vibecook/puppeteer-view-sdk/model';
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
  /** Where the person asked for each row, for views that place new arrivals spatially. */
  readonly spawnHints: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
}

/** The theme's colour function (L7). The same `key` promises the same colours, so only a new key re-colours. */
export interface MonitorReplicaTheme {
  readonly key: string;
  /** A project's colour from its sequence; no sequence: the neutral ramp. */
  colourFor(seq?: number): string;
}

/** Runs `callback` once, before the next frame, and returns its cancel. */
export type MonitorReplicaScheduler = (callback: () => void) => () => void;

export interface CreateMonitorReplicaOptions {
  /** Default: `requestAnimationFrame` where there is one, else a 16 ms timer. */
  scheduler?: MonitorReplicaScheduler;
  /** Hears what a listener or a host callback threw; nothing a host passes in can stop a publication. */
  onListenerError?: (error: unknown) => void;
}

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
   * and `onGap` asks the host for a snapshot. False: nothing was applied.
   */
  apply(update: MonitorModelSnapshot | MonitorModelChange): boolean;
  /** Heard once each time the chain breaks; changes are refused until the next snapshot. */
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

function frameScheduler(): MonitorReplicaScheduler {
  const { requestAnimationFrame, cancelAnimationFrame } = frameGlobals;
  if (typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function') {
    return (callback) => {
      const handle = requestAnimationFrame.call(globalThis, () => callback());
      return () => cancelAnimationFrame.call(globalThis, handle);
    };
  }
  return (callback) => {
    const handle = setTimeout(callback, 16);
    return () => clearTimeout(handle);
  };
}

/** The ids of `views` that are in `ids`, in the views' order. */
function idsIn(views: readonly AgentView[], ids: ReadonlySet<string>): readonly string[] {
  if (ids.size === 0) return NO_IDS;
  return Object.freeze(views.filter((view) => ids.has(view.id)).map((view) => view.id));
}

export function createMonitorReplica(options: CreateMonitorReplicaOptions = {}): MonitorReplica {
  const scheduler = options.scheduler ?? frameScheduler();
  /** The backend's rows at the held revision, frozen. */
  const rows = new Map<string, MonitorAgentRow>();
  /** The published views and the rows they were joined from. Changed only when a frame publishes. */
  const joined = new Map<string, Joined>();
  /** Rows whose view may differ from the published one. */
  const dirty = new Set<string>();
  /** Colours by project sequence under the current theme key. */
  const colours = new Map<number | undefined, string>();
  const listeners = new Set<() => void>();
  const gapListeners = new Set<() => void>();
  let revision: number | undefined;
  let gapped = false;
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

  /** The row joined with this window's facts: the published view itself when none of them moved. */
  const join = (row: MonitorAgentRow, held: Joined | undefined): AgentView => {
    const previous = held?.view;
    const colour = colourOf(row.project.seq);
    const active = local.activeIds.has(row.id);
    const receded = recededOf(row);
    const attachment = attachmentOf(row.id, previous?.attachment);
    const spawnHint = spawnHintOf(row.id, previous?.spawnHint);
    if (
      previous !== undefined &&
      held?.row === row &&
      previous.colour === colour &&
      previous.active === active &&
      previous.receded === receded &&
      previous.attachment === attachment &&
      previous.spawnHint === spawnHint
    ) {
      return previous;
    }
    return Object.freeze({
      ...row,
      colour,
      active,
      receded,
      ...(attachment ? { attachment } : {}),
      ...(spawnHint ? { spawnHint } : {}),
    });
  };

  const flush = (): void => {
    if (disposed) return;
    // Computed aside and committed at the end, so the published state never holds half a frame.
    const updates = new Map<string, Joined | undefined>();
    for (const id of dirty) {
      const row = rows.get(id);
      const held = joined.get(id);
      if (!row) {
        if (held) updates.set(id, undefined);
        continue;
      }
      const view = join(row, held);
      if (view !== held?.view) updates.set(id, { row, view });
    }
    dirty.clear();

    let model = published.model;
    let changes = NO_CHANGES;
    if (updates.size > 0) {
      const added = new Set<string>();
      const updated = new Set<string>();
      const removed = new Set<string>();
      for (const [id, next] of updates) {
        if (!next) {
          joined.delete(id);
          removed.add(id);
          continue;
        }
        (joined.has(id) ? updated : added).add(id);
        joined.set(id, next);
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

  const schedule = (): void => {
    if (disposed || framePending || (dirty.size === 0 && spawn === published.spawn)) return;
    framePending = true;
    const cancel = scheduler(() => {
      framePending = false;
      cancelFrame = undefined;
      flush();
    });
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
      } else {
        if (gapped) return false;
        if (revision === undefined || update.since !== revision) {
          gap();
          return false;
        }
        revision = update.revision;
        for (const row of update.upserts) take(row);
        for (const id of update.removed) {
          if (rows.delete(id)) dirty.add(id);
        }
        if (update.spawn !== undefined) takeSpawn(update.spawn);
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
      if (next.receded !== previous.receded) for (const id of rows.keys()) dirty.add(id);
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
