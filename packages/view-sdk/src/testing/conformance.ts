/**
 * The conformance suite (MV-W4): what every monitor view must do, run against
 * the view itself in a DOM (happy-dom in a view's tests).
 *
 * - It draws 0, 1 and 20 agents, in both schemes, at three stage sizes, and
 *   survives a scheme flip while mounted.
 * - It never writes to its input: every input is deep-frozen, so a write
 *   throws where it happens.
 * - Every node it makes stays inside its root, and the document outside is
 *   unchanged after each step and after unmount.
 * - Unmounted, it leaves its root empty, asks for no more frames, and leaves
 *   no listener on the window or the document.
 * - With animations off, or motion reduced, no frame loop runs.
 * - It binds no keys on the window or the document (keys are bound on its own
 *   root, only while focused, MV-D8).
 *
 * `checkConformance` runs the suite and returns what failed. `runConformance`
 * registers it as a vitest `describe`, one test per check.
 */

import React from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { compareMonitorRows, type AgentView } from '../model.js';
import { allAdded, diffModels } from '../internal/input.js';
import type {
  MonitorCapabilities,
  MonitorParameterValues,
  MonitorTheme,
  MonitorView,
  MonitorViewInput,
  MonitorViewInstance,
} from '../view.js';
import { countingCommands } from './counters.js';
import {
  agentViewsFixture,
  fixtureModel,
  fixtureStage,
  fixtureTheme,
  NO_CAPABILITIES,
  parameterDefaults,
  type FixtureScheme,
  type FixtureStageSize,
} from './fixtures.js';
import { deepFreeze } from './freeze.js';
import { createFrameDriver, type FrameDriver } from './frames.js';
import { overrideProperty } from './override.js';

export type ConformanceCheckId =
  'renders' | 'immutable-input' | 'own-root' | 'cleans-up' | 'still-when-asked' | 'no-global-keys';

export const CONFORMANCE_CHECKS: readonly { readonly id: ConformanceCheckId; readonly title: string }[] = [
  { id: 'renders', title: 'mounts, updates and unmounts at every agent count, in both schemes, at every stage size' },
  { id: 'immutable-input', title: 'never writes to its input' },
  { id: 'own-root', title: 'keeps every node it makes inside its root' },
  { id: 'cleans-up', title: 'leaves nothing behind when it unmounts' },
  { id: 'still-when-asked', title: 'runs no frame loop while animations are off or motion is reduced' },
  { id: 'no-global-keys', title: 'binds no keys on the window or the document' },
];

export interface ConformanceOptions {
  /** Default 0, 1 and 20, in that order, as updates of one mount. */
  readonly agentCounts?: readonly number[] | undefined;
  readonly schemes?: readonly FixtureScheme[] | undefined;
  /** Default compact, default and wide. */
  readonly sizes?: readonly FixtureStageSize[] | undefined;
  /** The agents for a count. Default: the first `count` of `agentViewsFixture(max)`, so a kept agent keeps its object. */
  readonly agents?: ((count: number) => readonly AgentView[]) | undefined;
  /** Default: the manifest's parameter defaults. */
  readonly parameters?: MonitorParameterValues | undefined;
  readonly capabilities?: MonitorCapabilities | undefined;
  /** The host lends TV-8's optional `openEnded` command. Default false: the view is handed the three alone. */
  readonly openEnded?: boolean | undefined;
  /** Frames a still view may take to finish one-shot work before it must stop asking. Default 5. */
  readonly settleFrames?: number | undefined;
  /** Checks not run. Each one skipped is a hole in the wall: say why beside it. */
  readonly skip?: readonly ConformanceCheckId[] | undefined;
}

export interface ConformanceFailure {
  readonly check: ConformanceCheckId;
  /** Where: `"<scheme> · <size> · <step>"`, or the motion case's name. */
  readonly case: string;
  readonly message: string;
}

export interface ConformanceReport {
  readonly view: string;
  readonly ok: boolean;
  /** Mounts the suite made. */
  readonly cases: number;
  readonly failures: readonly ConformanceFailure[];
}

const KEY_EVENTS = new Set(['keydown', 'keyup', 'keypress']);
const MUTATION =
  /read[- ]only|not extensible|frozen|cannot assign|cannot add property|cannot delete|cannot define property|cannot redefine/i;

type Act = (work: () => unknown) => Promise<void>;

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function errorsOf(error: unknown): unknown[] {
  return typeof AggregateError !== 'undefined' && error instanceof AggregateError ? [...error.errors] : [error];
}

/** The document as text, with the view's root as one opaque line: any change outside it shows. */
function describeOutside(root: Element): string {
  const lines: string[] = [];
  const walk = (node: Node, depth: number): void => {
    if (node === root) {
      lines.push(`${depth} [view root]`);
      return;
    }
    if (node.nodeType === 1) {
      const element = node as Element;
      const attributes = [...element.attributes].map((attribute) => `${attribute.name}="${attribute.value}"`);
      lines.push(`${depth} <${element.tagName.toLowerCase()} ${attributes.join(' ')}>`);
    } else if (node.nodeType === 3) {
      lines.push(`${depth} "${node.textContent ?? ''}"`);
    } else {
      lines.push(`${depth} #${node.nodeType}`);
    }
    for (const child of node.childNodes) walk(child, depth + 1);
  };
  walk(root.ownerDocument.documentElement, 0);
  return lines.join('\n');
}

interface ListenerRecord {
  readonly target: string;
  readonly type: string;
  readonly listener: unknown;
  readonly capture: boolean;
}

/** Who listens on the window and the document while the suite runs. */
function trackGlobalListeners() {
  const records: ListenerRecord[] = [];
  const keys = new Set<string>();
  const targets = new Map<EventTarget, string>([[window, 'window']]);
  if (!targets.has(document)) targets.set(document, 'document');
  const restores = [...targets].flatMap(([target, name]) => {
    const add = target.addEventListener;
    const remove = target.removeEventListener;
    const forget = (type: string, listener: unknown, capture: boolean): void => {
      const index = records.findIndex(
        (record) =>
          record.target === name && record.type === type && record.listener === listener && record.capture === capture,
      );
      if (index >= 0) records.splice(index, 1);
    };
    const tracked = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
      const signal = typeof options === 'object' ? options.signal : undefined;
      if (KEY_EVENTS.has(type)) keys.add(`${type} on the ${name}`);
      // React DOM's own: one per document, at its first root, never removed. Not the view's.
      const reacts = name === 'document' && type === 'selectionchange';
      // An already-aborted signal adds nothing.
      if (listener !== null && !reacts && signal?.aborted !== true) {
        records.push({ target: name, type, listener, capture });
        signal?.addEventListener('abort', () => forget(type, listener, capture), { once: true });
      }
      add.call(this, type, listener, options);
    };
    const untracked = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ): void {
      forget(type, listener, typeof options === 'boolean' ? options : Boolean(options?.capture));
      remove.call(this, type, listener, options);
    };
    return [
      overrideProperty(target, 'addEventListener', tracked),
      overrideProperty(target, 'removeEventListener', untracked),
    ];
  });
  return {
    live: (): string[] => records.map((record) => `a '${record.type}' listener on the ${record.target}`),
    keys: (): string[] => [...keys],
    clear(): void {
      records.length = 0;
      keys.clear();
    },
    restore(): void {
      for (const restore of restores.reverse()) restore();
    },
  };
}

/** Runs the suite. Needs a DOM; installs its own animation frame for the duration. */
export async function checkConformance(
  view: MonitorView,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    throw new Error(
      'checkConformance needs a DOM: start the test file with `// @vitest-environment happy-dom` (happy-dom a devDependency)',
    );
  }
  const counts = options.agentCounts ?? [0, 1, 20];
  const schemes = options.schemes ?? ['light', 'dark'];
  const sizes = options.sizes ?? ['compact', 'default', 'wide'];
  const settleFrames = options.settleFrames ?? 5;
  const skipped = new Set(options.skip ?? []);
  const parameters = options.parameters ?? parameterDefaults(view.manifest);
  const capabilities = options.capabilities ?? NO_CAPABILITIES;
  const most = Math.max(0, ...counts);
  const crowd = [...agentViewsFixture(most)].sort(compareMonitorRows);
  const agentsFor = options.agents ?? ((count: number) => crowd.slice(0, count));

  const failures: ConformanceFailure[] = [];
  let cases = 0;
  let where = '';
  const fail = (check: ConformanceCheckId, message: string, at = where): void => {
    if (!skipped.has(check)) failures.push({ check, case: at, message });
  };
  const failWith = (error: unknown): void => {
    for (const each of errorsOf(error)) {
      fail(
        each instanceof TypeError && MUTATION.test(each.message) ? 'immutable-input' : 'renders',
        describeError(each),
      );
    }
  };

  const frames: FrameDriver = createFrameDriver({ onError: failWith });
  const restoreFrames = frames.install();
  const onWindowError = (event: ErrorEvent): void => {
    event.preventDefault();
    failWith(event.error ?? event.message);
  };
  window.addEventListener('error', onWindowError);
  const listeners = trackGlobalListeners();
  const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const actEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  const reactAct = (React as unknown as { act?: (callback: () => Promise<void>) => Promise<void> }).act;
  if (typeof reactAct === 'function') environment.IS_REACT_ACT_ENVIRONMENT = true;
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const act: Act = async (work) => {
    try {
      const run = async (): Promise<void> => {
        await work();
        await settle();
      };
      if (typeof reactAct === 'function') await reactAct(run);
      else await run();
    } catch (error) {
      failWith(error);
    }
  };

  const inputFor = (
    count: number,
    theme: MonitorTheme,
    size: FixtureStageSize,
    previous: MonitorViewInput | undefined,
  ): MonitorViewInput => {
    const agents = agentsFor(count);
    const sameAgents =
      previous !== undefined &&
      previous.model.agents.length === agents.length &&
      agents.every((agent, index) => agent === previous.model.agents[index]);
    const model = sameAgents ? previous.model : fixtureModel(agents, (previous?.model.revision ?? 0) + 1);
    return deepFreeze({
      model,
      changes: previous === undefined ? allAdded(model) : diffModels(previous.model, model),
      stage: fixtureStage(size),
      theme,
      parameters,
      capabilities,
    });
  };

  /** One mount: the steps as updates, then the unmount and everything it must leave behind. */
  const runCase = async (
    label: string,
    steps: readonly {
      readonly name: string;
      readonly input: (previous: MonitorViewInput | undefined) => MonitorViewInput;
    }[],
    afterSteps?: () => Promise<void>,
  ): Promise<void> => {
    cases += 1;
    const container = document.createElement('div');
    container.setAttribute('data-conformance', view.manifest.id);
    document.body.append(container);
    const root = document.createElement('div');
    container.append(root);
    const outside = describeOutside(root);
    const checkOutside = (): void => {
      if (describeOutside(root) !== outside) fail('own-root', 'changed the document outside its root');
    };
    const { commands } = countingCommands({ openEnded: options.openEnded });
    let instance: MonitorViewInstance | undefined;
    let previous: MonitorViewInput | undefined;
    for (const [index, step] of steps.entries()) {
      where = `${label} · ${step.name}`;
      const input = step.input(previous);
      if (index === 0) {
        const before = failures.length;
        await act(() => {
          instance = view.mount(root, input, commands);
        });
        if (typeof instance?.update !== 'function' || typeof instance.unmount !== 'function') {
          if (failures.length === before) fail('renders', 'mount returned no { update, unmount }');
          instance = undefined;
          break;
        }
      } else {
        await act(() => instance?.update(input));
      }
      await act(() => frames.step(2));
      checkOutside();
      previous = input;
    }
    if (afterSteps !== undefined && instance !== undefined) await afterSteps();
    where = `${label} · unmount`;
    if (instance !== undefined) {
      await act(() => instance?.unmount());
      await act(() => frames.step(2));
      if (frames.pending > 0) {
        fail('cleans-up', `still asks for animation frames after unmount (${frames.pending} pending)`);
        frames.clear();
      }
      if (root.childNodes.length > 0) fail('cleans-up', `left ${root.childNodes.length} node(s) in its root`);
      for (const leaked of listeners.live()) fail('cleans-up', `left ${leaked}`);
    }
    for (const key of listeners.keys()) fail('no-global-keys', `listens for ${key} (MV-W2, MV-D8)`, label);
    listeners.clear();
    checkOutside();
    container.remove();
  };

  try {
    for (const scheme of schemes) {
      const flipped = fixtureTheme(scheme === 'light' ? 'dark' : 'light');
      for (const size of sizes) {
        const theme = fixtureTheme(scheme);
        await runCase(`${scheme} · ${size}`, [
          ...counts.map((count) => ({
            name: `${count} agents`,
            input: (previous: MonitorViewInput | undefined) => inputFor(count, theme, size, previous),
          })),
          { name: 'scheme flip', input: (previous) => inputFor(most, flipped, size, previous) },
        ]);
      }
    }
    for (const [label, theme] of [
      ['animations off', fixtureTheme('dark', { animations: false })],
      ['reduced motion', fixtureTheme('dark', { reducedMotion: true })],
    ] as const) {
      await runCase(
        label,
        [{ name: `${most} agents`, input: () => inputFor(most, theme, 'default', undefined) }],
        async () => {
          where = label;
          await act(() => frames.step(settleFrames));
          let asking = frames.pending > 0;
          for (let frame = 0; asking && frame < 3; frame += 1) {
            await act(() => frames.step());
            asking = frames.pending > 0;
          }
          if (asking) fail('still-when-asked', `still asks for a frame every frame after ${settleFrames + 3} frames`);
        },
      );
    }
  } finally {
    listeners.restore();
    window.removeEventListener('error', onWindowError);
    restoreFrames();
    if (actEnvironment === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT;
    else environment.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
  }

  return { view: view.manifest.id, ok: failures.length === 0, cases, failures };
}

export function formatConformanceFailures(failures: readonly ConformanceFailure[]): string[] {
  return failures.map((failure) => `[${failure.case}] ${failure.message}`);
}

/**
 * Registers the suite for `view` as a vitest `describe`, one test per check:
 * call it at the top level of the view's test file.
 */
export function runConformance(view: MonitorView, options: ConformanceOptions = {}): void {
  describe(`monitor view conformance: ${view.manifest.id}`, () => {
    let report: ConformanceReport | undefined;
    beforeAll(async () => {
      report = await checkConformance(view, options);
    }, 60_000);
    for (const check of CONFORMANCE_CHECKS) {
      if (options.skip?.includes(check.id)) {
        it.skip(check.title, () => undefined);
        continue;
      }
      it(check.title, () => {
        expect(report, 'the suite did not run').toBeDefined();
        expect(formatConformanceFailures(report!.failures.filter((failure) => failure.check === check.id))).toEqual([]);
      });
    }
  });
}
