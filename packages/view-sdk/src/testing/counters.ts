/**
 * Counters for what a view costs (MV-0's per-view instruments, in a test):
 * the commands it calls, the React commits it makes, the effects it runs.
 * Frames are counted by `createFrameDriver`.
 */

import React, { createElement, Profiler, type ProfilerOnRenderCallback } from 'react';
import type { MonitorSpawnTarget } from '../model.js';
import { reactMonitorView, type ReactMonitorView, type ReactMonitorViewProps } from '../react/index.js';
import type { MonitorCreateAnswer, MonitorViewCommands, ViewReport } from '../view.js';

export interface CountingCommands {
  readonly commands: MonitorViewCommands;
  readonly selects: readonly string[];
  readonly creates: readonly {
    readonly at?: { readonly x: number; readonly y: number };
    readonly target?: MonitorSpawnTarget;
  }[];
  readonly reports: readonly ViewReport[];
  /** Every call of the three. */
  readonly calls: number;
  reset(): void;
}

/** Commands that do nothing but remember each call. */
export function countingCommands(): CountingCommands {
  const selects: string[] = [];
  const creates: { at?: { readonly x: number; readonly y: number }; target?: MonitorSpawnTarget }[] = [];
  const reports: ViewReport[] = [];
  return {
    commands: Object.freeze({
      select: (agentId: string) => {
        selects.push(agentId);
      },
      create: (at?: { readonly x: number; readonly y: number }, target?: MonitorSpawnTarget) => {
        creates.push({ ...(at !== undefined ? { at } : {}), ...(target !== undefined ? { target } : {}) });
        return Promise.resolve<MonitorCreateAnswer>({ opened: true });
      },
      report: (report: ViewReport) => {
        reports.push(report);
      },
    }),
    selects,
    creates,
    reports,
    get calls() {
      return selects.length + creates.length + reports.length;
    },
    reset() {
      selects.length = 0;
      creates.length = 0;
      reports.length = 0;
    },
  };
}

export interface CommitCounter {
  /** The counted copy of the view: mount this one. */
  readonly view: ReactMonitorView;
  /** React commits of the view's tree, its mount's included. */
  readonly commits: number;
  reset(): void;
}

/**
 * Counts a React view's commits through a `Profiler` around its component.
 * Profilers report in React's development and profiling builds, which is
 * what tests run. The counted copy keeps the view's root class (M67), so its
 * stylesheet applies and a lab counts the view as it draws, not unstyled.
 */
export function countCommits(view: ReactMonitorView): CommitCounter {
  if (view.Component === undefined) throw new TypeError(`countCommits counts a view built by reactMonitorView`);
  let commits = 0;
  const onRender: ProfilerOnRenderCallback = () => {
    commits += 1;
  };
  const { Component } = view;
  function Counted(props: ReactMonitorViewProps) {
    return createElement(Profiler, { id: view.manifest.id, onRender }, createElement(Component, props));
  }
  return {
    view: reactMonitorView(view.manifest, Counted, { rootClass: view.rootClass }),
    get commits() {
      return commits;
    },
    reset() {
      commits = 0;
    },
  };
}

export interface EffectCounter {
  /** Effect bodies that ran: a mount, or a run again because a dependency changed. */
  readonly runs: number;
  /** Cleanups that ran. */
  readonly cleanups: number;
  reset(): void;
  /** Stops counting. Counters nest only last-in, first-out. */
  restore(): void;
}

type EffectHook = (create: () => unknown, ...rest: unknown[]) => unknown;
type Dispatcher = Record<string, unknown>;

const EFFECT_HOOKS = ['useEffect', 'useLayoutEffect', 'useInsertionEffect'] as const;
const INTERNALS = '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE';

/**
 * Counts every React effect that runs in this realm until `restore()`, without
 * touching the view's code: it wraps the effect hooks of React 19's hooks
 * dispatcher, so each effect body and cleanup counts as React calls it. An
 * effect that re-runs on an update is the identity churn MV-D21 exists to
 * prevent (a palette re-resolved, a canvas reset, every agent re-posted).
 *
 * It reads React's private internals, so it is a test instrument only: it
 * throws on a React without them rather than count wrong.
 */
export function countReactEffects(): EffectCounter {
  const internals = (React as unknown as Record<string, unknown>)[INTERNALS] as Record<string, unknown> | undefined;
  const descriptor = internals === undefined ? undefined : Object.getOwnPropertyDescriptor(internals, 'H');
  if (internals === undefined || descriptor === undefined || !('value' in descriptor) || !descriptor.writable) {
    throw new Error(
      'countReactEffects needs React 19 (its hooks dispatcher was not found where it expects it, or another counter holds it)',
    );
  }
  let runs = 0;
  let cleanups = 0;
  let current = descriptor.value as Dispatcher | null;
  const wrappers = new WeakMap<Dispatcher, Dispatcher>();
  const originals = new WeakMap<Dispatcher, Dispatcher>();

  const counted = (create: () => unknown) => (): unknown => {
    runs += 1;
    const cleanup = create();
    if (typeof cleanup !== 'function') return cleanup;
    return () => {
      cleanups += 1;
      return (cleanup as () => unknown)();
    };
  };

  const wrap = (dispatcher: Dispatcher | null): Dispatcher | null => {
    if (dispatcher === null) return null;
    let wrapper = wrappers.get(dispatcher);
    if (wrapper === undefined) {
      const made: Dispatcher = Object.create(dispatcher) as Dispatcher;
      for (const name of EFFECT_HOOKS) {
        const hook = dispatcher[name];
        if (typeof hook !== 'function') continue;
        made[name] = (create: unknown, ...rest: unknown[]) =>
          (hook as EffectHook)(
            typeof create === 'function' ? counted(create as () => unknown) : (create as () => unknown),
            ...rest,
          );
      }
      wrappers.set(dispatcher, made);
      originals.set(made, dispatcher);
      wrapper = made;
    }
    return wrapper;
  };

  Object.defineProperty(internals, 'H', {
    configurable: true,
    enumerable: descriptor.enumerable ?? true,
    get: () => wrap(current),
    set: (value: Dispatcher | null) => {
      current = value === null ? null : (originals.get(value) ?? value);
    },
  });

  let restored = false;
  return {
    get runs() {
      return runs;
    },
    get cleanups() {
      return cleanups;
    },
    reset() {
      runs = 0;
      cleanups = 0;
    },
    restore() {
      if (restored) return;
      restored = true;
      Object.defineProperty(internals, 'H', { ...descriptor, value: current });
    },
  };
}
