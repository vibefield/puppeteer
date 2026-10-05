/**
 * The legacy bridge (L6): until a view is ported, the host mounts its old
 * `AgentMonitorView` component through the same slot as an SDK view.
 *
 * The SDK knows nothing of the old props. The host builds them from the input
 * with `toProps` (L9's shim, which lives in puppeteer-views, turns each
 * `AgentView` into a `MonitorAgent`), and keeps the providers the old view
 * still reads above it with `wrap` (the swarm's `SwarmPhysicsProvider`). MV-8
 * deletes the bridge with the shim.
 */

import { createElement, type Attributes, type ComponentType, type ReactElement } from 'react';
import { sameInputParts } from '../internal/input.js';
import { createViewRoot, releaseViewRoot, renderViewRoot } from '../internal/react-root.js';
import {
  defineMonitorView,
  MONITOR_VIEW_SDK_MAJOR,
  type MonitorParameterGroup,
  type MonitorView,
  type MonitorViewCommands,
  type MonitorViewInput,
  type MonitorViewInstance,
  type MonitorViewKey,
  type MonitorViewManifest,
  type MonitorViewMark,
} from '../view.js';

/**
 * Enough of a manifest to mount an old view: a legacy registry entry
 * (`AgentMonitorView`) already is one. The rest of a manifest is optional here.
 */
export interface LegacyManifestLike {
  readonly id: string;
  readonly label: string;
  /** The legacy registry's name for `parameters`. */
  readonly parameterGroups?: readonly MonitorParameterGroup[] | undefined;
  readonly parameters?: readonly MonitorParameterGroup[] | undefined;
  readonly parametersRevision?: string | undefined;
  /** Absent: an empty mark; until MV-8 the bar draws an old view by its own table. */
  readonly mark?: MonitorViewMark | undefined;
  readonly keys?: readonly MonitorViewKey[] | undefined;
  readonly capabilities?: MonitorViewManifest['capabilities'];
  /** Absent: `{ loops: true }`, so the ambient-motion audit flags an old view rather than misses one. */
  readonly motion?: { readonly loops: boolean } | undefined;
}

export interface LegacyMonitorView extends MonitorView {
  readonly legacy: true;
  /**
   * Renders every mounted instance again with fresh props. For host state
   * `toProps` reads beside the input: the timeline's status history until MV-6
   * (L10) changes without the model changing.
   */
  refresh(): void;
}

const NO_MARK: MonitorViewMark = Object.freeze({ viewBox: '0 0 16 16', paths: Object.freeze([]) });
const LOOPS = Object.freeze({ loops: true });

export function legacyView<P extends object>(
  manifestLike: LegacyManifestLike,
  Component: ComponentType<P>,
  toProps: (input: MonitorViewInput, commands: MonitorViewCommands) => P,
  wrap?: (view: ReactElement) => ReactElement,
): LegacyMonitorView {
  const manifest: MonitorViewManifest = {
    sdk: MONITOR_VIEW_SDK_MAJOR,
    id: manifestLike.id,
    label: manifestLike.label,
    mark: manifestLike.mark ?? NO_MARK,
    parameters: manifestLike.parameters ?? manifestLike.parameterGroups ?? [],
    ...(manifestLike.parametersRevision !== undefined ? { parametersRevision: manifestLike.parametersRevision } : {}),
    ...(manifestLike.capabilities !== undefined ? { capabilities: manifestLike.capabilities } : {}),
    ...(manifestLike.keys !== undefined ? { keys: manifestLike.keys } : {}),
    motion: manifestLike.motion ?? LOOPS,
  };
  const renders = new Set<() => void>();
  const view: LegacyMonitorView = {
    manifest,
    legacy: true,
    refresh() {
      for (const render of [...renders]) render();
    },
    mount(element, input, commands): MonitorViewInstance {
      const root = createViewRoot(element, manifest.id);
      let current = input;
      let live = true;
      const render = (inFrame = false): void => {
        const old = createElement(
          Component as ComponentType<P & Attributes>,
          toProps(current, commands) as P & Attributes,
        );
        const element = wrap === undefined ? old : wrap(old);
        // An update comes from the slot's frame and commits in it (M62); a mount or a refresh renders as React schedules.
        if (inFrame) renderViewRoot(root, element);
        else root.render(element);
      };
      const refresh = (): void => render();
      renders.add(refresh);
      render();
      return {
        update(next) {
          if (!live) return;
          const changed = !sameInputParts(current, next);
          current = next;
          if (changed) render(true);
        },
        unmount() {
          if (!live) return;
          live = false;
          renders.delete(refresh);
          releaseViewRoot(root);
        },
      };
    },
  };
  defineMonitorView(view);
  return view;
}

export function isLegacyMonitorView(view: MonitorView): view is LegacyMonitorView {
  return (view as Partial<LegacyMonitorView>).legacy === true;
}
