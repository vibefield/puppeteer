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
import type { MonitorSpawnTarget } from '../model.js';
import {
  defineMonitorView,
  type ModelChanges,
  type MonitorCapabilities,
  type MonitorModel,
  type MonitorParameterValues,
  type MonitorTheme,
  type MonitorView,
  type MonitorViewCommands,
  type MonitorViewInput,
  type MonitorViewInstance,
  type StageGeometry,
  type ViewReport,
} from '../view.js';
import { frameScheduler, type FrameScheduler } from './frame-scheduler.js';
import { keepRecord, keepStage, keepTheme } from './parts.js';

/**
 * The replica as the slot reads it: the model and a change signal. The slot
 * diffs the model it last gave the view against the new one (by identity,
 * MV-D21), so it reads `model` only; `changes` is the replica's own account.
 */
export interface MonitorReplicaLike {
  getSnapshot(): { readonly model: MonitorModel; readonly changes: ModelChanges };
  subscribe(onChange: () => void): () => void;
}

/** What the host supplies beside the replica. It measures its own chrome into `stage` (MV-D19). */
export interface ViewSlotInput {
  readonly stage: StageGeometry;
  readonly theme: MonitorTheme;
  readonly parameters: MonitorParameterValues;
  readonly capabilities?: MonitorCapabilities | undefined;
}

/** The host's side of two of the three commands; `report` is the slot's own. */
export type ViewSlotCommands = Pick<MonitorViewCommands, 'select' | 'create'>;

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
  let capabilities = options.input.capabilities ?? NO_CAPABILITIES;
  let mounted: Mounted | undefined;
  let report = NO_REPORT;
  let modelDirty = false;
  let cancelFrame: (() => void) | undefined;
  let disposed = false;

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

  /** Each mount gets its own commands; once the view is gone they reach nothing. */
  const commandsFor = (entry: Mounted): MonitorViewCommands =>
    Object.freeze({
      select(agentId: string) {
        if (mounted === entry) options.commands.select(agentId);
      },
      create(at?: { readonly x: number; readonly y: number }, target?: MonitorSpawnTarget) {
        if (mounted === entry) options.commands.create(at, target);
      },
      report(delta: ViewReport) {
        if (mounted === entry) applyReport(delta);
      },
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
    const model = replica.getSnapshot().model;
    const input: MonitorViewInput = { model, changes: allAdded(model), stage, theme, parameters, capabilities };
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
    const model = modelDirty ? replica.getSnapshot().model : previous.model;
    modelDirty = false;
    if (
      model === previous.model &&
      stage === previous.stage &&
      theme === previous.theme &&
      parameters === previous.parameters &&
      capabilities === previous.capabilities
    ) {
      return;
    }
    const input: MonitorViewInput = {
      model,
      changes: model === previous.model ? NO_CHANGES : diffModels(previous.model, model),
      stage,
      theme,
      parameters,
      capabilities,
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
        parts.capabilities === undefined ? capabilities : keepRecord(capabilities, parts.capabilities);
      if (
        nextStage === stage &&
        nextTheme === theme &&
        nextParameters === parameters &&
        nextCapabilities === capabilities
      ) {
        return;
      }
      stage = nextStage;
      theme = nextTheme;
      parameters = nextParameters;
      capabilities = nextCapabilities;
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
