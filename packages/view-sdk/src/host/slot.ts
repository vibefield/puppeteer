/**
 * The view slot: where a host mounts exactly one view (L6), framework-free.
 *
 * The host owns the slot element. The slot gives each mounted view a fresh
 * root inside it, builds the view's input from a replica and the host's own
 * parts, and drives `update` at most once per frame, only when a part changed
 * identity. What a view reports reaches the host through `onReport` and is
 * mirrored as data attributes on the slot element, outside the view's root, so
 * a host never has to read a view's DOM (MV-W5).
 */

import { allAdded, diffModels, NO_CHANGES } from '../internal/input.js';
import type { FrameScheduler, ModelChanges, MonitorModel, MonitorSpawnMenu, MonitorSpawnTarget } from '../model.js';
import {
  defineMonitorView,
  type MonitorCapabilities,
  type MonitorCreateAnswer,
  type MonitorParameterValues,
  type MonitorTheme,
  type MonitorView,
  type MonitorViewCommands,
  type MonitorViewInput,
  type MonitorViewInstance,
  type StageGeometry,
  type ViewReport,
} from '../view.js';
import { frameScheduler } from './frame-scheduler.js';
import { keepRecord, keepStage, keepTheme } from './parts.js';

/**
 * The replica as the slot reads it: the model, the spawn menu, and a change
 * signal. The slot diffs the model it last gave the view against the new one
 * (by identity, MV-D21), so it reads `model` and `spawn`; `changes` is the
 * replica's own account.
 */
export interface MonitorReplicaLike {
  getSnapshot(): {
    readonly model: MonitorModel;
    readonly changes: ModelChanges;
    /** The backend's spawn menu (M2), the same object until a change carries a new one. */
    readonly spawn?: MonitorSpawnMenu | undefined;
  };
  subscribe(onChange: () => void): () => void;
}

/** What the host supplies beside the replica. It measures its own chrome into `stage` (MV-D19). */
export interface ViewSlotInput {
  readonly stage: StageGeometry;
  readonly theme: MonitorTheme;
  readonly parameters: MonitorParameterValues;
  /** The host's own. With no `spawn` of its own, the replica's menu fills `capabilities.spawn` (M2). */
  readonly capabilities?: MonitorCapabilities | undefined;
}

/**
 * The host's side of two of the three commands; `report` is the slot's own. A host's `create` may answer with a
 * promise, waited for (a rejection is a refusal), or with nothing: opened at once (M59).
 */
export interface ViewSlotCommands {
  select(agentId: string): void;
  create(at?: { readonly x: number; readonly y: number }, target?: MonitorSpawnTarget): void | Promise<unknown>;
  /**
   * TV-8, optional: open the ended run `id` (a `MonitorEndedRow`'s `past:…` id) where this host keeps past sessions.
   * The host answers it itself; nothing here sends it to the backend. A host with nowhere to open one leaves it out
   * (or `undefined`), and its views then get no `openEnded` at all, never a no-op: a view reads the command's
   * presence to decide whether an ended lane is a control. Presence is read as each view mounts, so give it from the
   * first render; the function itself may change freely, and a call reaches the latest one.
   */
  readonly openEnded?: ((id: string) => void) | undefined;
}

const OPENED: MonitorCreateAnswer = Object.freeze({ opened: true });
const REFUSED: MonitorCreateAnswer = Object.freeze({ opened: false });

/** The host's fulfilled, rejected or void return as the view's answer (M59): it never rejects. */
function answerOf(run: () => void | Promise<unknown>): Promise<MonitorCreateAnswer> {
  let answer: void | Promise<unknown>;
  try {
    answer = run();
  } catch {
    return Promise.resolve(REFUSED);
  }
  if (answer && typeof (answer as Promise<unknown>).then === 'function') {
    return (answer as Promise<unknown>).then(
      () => OPENED,
      () => REFUSED,
    );
  }
  return Promise.resolve(OPENED);
}

export type ViewSlotPhase = 'mount' | 'update' | 'unmount';

export interface ViewSlotOptions {
  readonly view: MonitorView;
  readonly replica: MonitorReplicaLike;
  readonly input: ViewSlotInput;
  readonly commands: ViewSlotCommands;
  /** The view's latest report, merged, whenever it changes (also when a switch clears it). */
  readonly onReport?: ((report: ViewReport, view: MonitorView) => void) | undefined;
  /** A view that threw. Absent, the error is rethrown; the slot itself stays usable either way. */
  readonly onError?: ((error: unknown, phase: ViewSlotPhase, view: MonitorView) => void) | undefined;
  /** Defaults to the shared `frameScheduler`. Pass the replica's, so both batch on one frame. */
  readonly scheduler?: FrameScheduler | undefined;
}

export interface ViewSlot {
  /** The view the slot shows (or tried to: a view whose mount threw shows nothing). */
  readonly view: MonitorView;
  /** The view's latest report, merged. */
  readonly report: ViewReport;
  /** Replaces some of the host's parts; a part equal in value to the current one keeps the current object. */
  setInput(parts: Partial<ViewSlotInput>): void;
  setReplica(replica: MonitorReplicaLike): void;
  /** Unmounts the current view, then mounts this one with the current input. */
  switchView(view: MonitorView): void;
  /** Applies pending changes now instead of at the next frame: outside the frame rule, for tests and measuring. */
  flush(): void;
  dispose(): void;
}

/** What the slot writes on the host's element. Every name is the host's, never a view's. */
export const VIEW_SLOT_ATTRIBUTES = Object.freeze({
  /** On the slot element while the slot lives. */
  slot: 'data-monitor-view-slot',
  /** The mounted view's manifest id. */
  view: 'data-monitor-view',
  /** `ViewReport.renderer`. */
  renderer: 'data-monitor-view-renderer',
  /** `ViewReport.physics`. */
  physics: 'data-monitor-view-physics',
  /** `"true"` while the view holds the keys (`ViewReport.keysHeld`); absent otherwise. */
  keysHeld: 'data-monitor-view-keys-held',
} as const);

/**
 * On each view's root, which fills the slot's nearest positioned ancestor
 * (`position: absolute; inset: 0`): the host places the slot, and measures the
 * stage in that ancestor's coordinates.
 */
export const VIEW_ROOT_ATTRIBUTE = 'data-monitor-view-root';

const NO_REPORT: ViewReport = Object.freeze({});
const NO_CAPABILITIES: MonitorCapabilities = Object.freeze({});
const REPORT_KEYS = ['renderer', 'physics', 'keysHeld'] as const;

interface Mounted {
  readonly view: MonitorView;
  readonly root: HTMLElement;
  input: MonitorViewInput;
  instance: MonitorViewInstance | undefined;
}

export function createViewSlot(slot: HTMLElement, options: ViewSlotOptions): ViewSlot {
  const scheduler = options.scheduler ?? frameScheduler;
  let replica = options.replica;
  let view = options.view;
  let stage = options.input.stage;
  let theme = options.input.theme;
  let parameters = options.input.parameters;
  let hostCapabilities = options.input.capabilities ?? NO_CAPABILITIES;
  let replicaSpawn: MonitorSpawnMenu | undefined;
  let joined:
    | { readonly host: MonitorCapabilities; readonly spawn: MonitorSpawnMenu; readonly value: MonitorCapabilities }
    | undefined;
  let mounted: Mounted | undefined;
  let report = NO_REPORT;
  let modelDirty = false;
  let cancelFrame: (() => void) | undefined;
  let disposed = false;

  /**
   * The capabilities the view sees: the host's, with the replica's spawn menu
   * when the host has none of its own. One object for as long as both parts
   * keep theirs, so the menu arriving again is no update.
   */
  const capabilities = (): MonitorCapabilities => {
    if (hostCapabilities.spawn !== undefined || replicaSpawn === undefined) return hostCapabilities;
    if (joined?.host !== hostCapabilities || joined.spawn !== replicaSpawn) {
      joined = {
        host: hostCapabilities,
        spawn: replicaSpawn,
        value: Object.freeze({ ...hostCapabilities, spawn: replicaSpawn }),
      };
    }
    return joined.value;
  };

  const fail = (error: unknown, phase: ViewSlotPhase, failing: MonitorView): void => {
    if (options.onError) options.onError(error, phase, failing);
    else throw error;
  };

  const setAttribute = (name: string, value: string | undefined): void => {
    if (value === undefined) slot.removeAttribute(name);
    else slot.setAttribute(name, value);
  };

  const writeReport = (): void => {
    setAttribute(VIEW_SLOT_ATTRIBUTES.renderer, report.renderer);
    setAttribute(VIEW_SLOT_ATTRIBUTES.physics, report.physics);
    setAttribute(VIEW_SLOT_ATTRIBUTES.keysHeld, report.keysHeld === true ? 'true' : undefined);
  };

  /** A report carries what changed: a key it sets replaces, a key set to undefined clears, a key it omits stays. */
  const applyReport = (delta: ViewReport): void => {
    let next: Record<string, unknown> | undefined;
    for (const key of REPORT_KEYS) {
      if (!Object.hasOwn(delta, key) || report[key] === delta[key]) continue;
      next ??= { ...report };
      if (delta[key] === undefined) delete next[key];
      else next[key] = delta[key];
    }
    if (next === undefined) return;
    report = Object.freeze(next) as ViewReport;
    writeReport();
    options.onReport?.(report, view);
  };

  const clearReport = (notify: boolean): void => {
    if (report === NO_REPORT) return;
    report = NO_REPORT;
    writeReport();
    if (notify) options.onReport?.(report, view);
  };

  /**
   * Each mount gets its own commands; once the view is gone they reach nothing. `openEnded` (TV-8) is among them only
   * when the host has one as the view mounts: absent stays absent, since the view reads its presence.
   */
  const commandsFor = (entry: Mounted): MonitorViewCommands =>
    Object.freeze({
      select(agentId: string) {
        if (mounted === entry) options.commands.select(agentId);
      },
      create(at?: { readonly x: number; readonly y: number }, target?: MonitorSpawnTarget) {
        if (mounted !== entry) return Promise.resolve(REFUSED);
        return answerOf(() => options.commands.create(at, target));
      },
      report(delta: ViewReport) {
        if (mounted === entry) applyReport(delta);
      },
      ...(options.commands.openEnded === undefined
        ? {}
        : {
            openEnded(id: string) {
              if (mounted === entry) options.commands.openEnded?.(id);
            },
          }),
    });

  const cancelPendingFrame = (): void => {
    cancelFrame?.();
    cancelFrame = undefined;
  };

  const mount = (next: MonitorView): void => {
    cancelPendingFrame();
    modelDirty = false;
    const root = slot.ownerDocument.createElement('div');
    root.setAttribute(VIEW_ROOT_ATTRIBUTE, '');
    root.style.cssText = 'position: absolute; inset: 0;';
    slot.append(root);
    slot.setAttribute(VIEW_SLOT_ATTRIBUTES.view, next.manifest.id);
    const snapshot = replica.getSnapshot();
    const model = snapshot.model;
    replicaSpawn = snapshot.spawn;
    const input: MonitorViewInput = {
      model,
      changes: allAdded(model),
      stage,
      theme,
      parameters,
      capabilities: capabilities(),
    };
    const entry: Mounted = { view: next, root, input, instance: undefined };
    mounted = entry;
    try {
      entry.instance = next.mount(root, input, commandsFor(entry));
    } catch (error) {
      if (mounted === entry) {
        mounted = undefined;
        root.remove();
        slot.removeAttribute(VIEW_SLOT_ATTRIBUTES.view);
        clearReport(false);
      }
      fail(error, 'mount', next);
    }
  };

  /** Takes the current view down. Its root leaves the document even when its unmount throws. */
  const unmountCurrent = (notify: boolean): { error: unknown } | undefined => {
    const current = mounted;
    if (current === undefined) return undefined;
    mounted = undefined;
    let failure: { error: unknown } | undefined;
    try {
      current.instance?.unmount();
    } catch (error) {
      failure = { error };
    }
    current.root.remove();
    clearReport(notify);
    return failure;
  };

  const flush = (): void => {
    cancelPendingFrame();
    const current = mounted;
    if (disposed || current === undefined) {
      modelDirty = false;
      return;
    }
    if (current.instance === undefined) {
      // Still mounting (a report from inside `mount` led here): the frame after will do.
      cancelFrame = scheduler.request(flushInFrame);
      return;
    }
    const previous = current.input;
    let model = previous.model;
    if (modelDirty) {
      const snapshot = replica.getSnapshot();
      model = snapshot.model;
      replicaSpawn = snapshot.spawn;
    }
    modelDirty = false;
    const nextCapabilities = capabilities();
    if (
      model === previous.model &&
      stage === previous.stage &&
      theme === previous.theme &&
      parameters === previous.parameters &&
      nextCapabilities === previous.capabilities
    ) {
      return;
    }
    const input: MonitorViewInput = {
      model,
      changes: model === previous.model ? NO_CHANGES : diffModels(previous.model, model),
      stage,
      theme,
      parameters,
      capabilities: nextCapabilities,
    };
    current.input = input;
    try {
      current.instance.update(input);
    } catch (error) {
      fail(error, 'update', current.view);
    }
  };

  // One function for the slot's frame work: the scheduler runs it at most once per frame.
  const flushInFrame = (): void => {
    cancelFrame = undefined;
    flush();
  };

  const requestFlush = (): void => {
    if (disposed || cancelFrame !== undefined) return;
    cancelFrame = scheduler.request(flushInFrame);
  };

  const onReplica = (): void => {
    modelDirty = true;
    requestFlush();
  };

  defineMonitorView(view);
  slot.setAttribute(VIEW_SLOT_ATTRIBUTES.slot, '');
  let unsubscribe = replica.subscribe(onReplica);
  try {
    mount(view);
  } catch (error) {
    // Rethrown with no slot to hand back: leave nothing subscribed or written.
    unsubscribe();
    slot.removeAttribute(VIEW_SLOT_ATTRIBUTES.slot);
    throw error;
  }

  return {
    get view() {
      return view;
    },
    get report() {
      return report;
    },
    setInput(parts) {
      if (disposed) return;
      const nextStage = parts.stage === undefined ? stage : keepStage(stage, parts.stage);
      const nextTheme = parts.theme === undefined ? theme : keepTheme(theme, parts.theme);
      const nextParameters = parts.parameters === undefined ? parameters : keepRecord(parameters, parts.parameters);
      const nextCapabilities =
        parts.capabilities === undefined ? hostCapabilities : keepRecord(hostCapabilities, parts.capabilities);
      if (
        nextStage === stage &&
        nextTheme === theme &&
        nextParameters === parameters &&
        nextCapabilities === hostCapabilities
      ) {
        return;
      }
      stage = nextStage;
      theme = nextTheme;
      parameters = nextParameters;
      hostCapabilities = nextCapabilities;
      requestFlush();
    },
    setReplica(next) {
      if (disposed || next === replica) return;
      unsubscribe();
      replica = next;
      unsubscribe = next.subscribe(onReplica);
      onReplica();
    },
    switchView(next) {
      if (disposed || next === view) return;
      // Refused before anything is taken down: a view built for another contract leaves the current one standing.
      defineMonitorView(next);
      const previous = view;
      view = next;
      // The old view's report goes with it; the host hears the new view's, empty until it reports.
      const failure = unmountCurrent(true);
      mount(next);
      if (failure !== undefined) fail(failure.error, 'unmount', previous);
    },
    flush,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelPendingFrame();
      unsubscribe();
      const failure = unmountCurrent(false);
      for (const name of Object.values(VIEW_SLOT_ATTRIBUTES)) slot.removeAttribute(name);
      if (failure !== undefined) fail(failure.error, 'unmount', view);
    },
  };
}
