/**
 * The React adapter (MV-D2): a monitor view written as a React component.
 *
 * `reactMonitorView(manifest, Component)` is a `MonitorView`. Each mount is its
 * own React root on the element the host hands the view, so the component
 * shares nothing with the host's tree. It receives the whole input and the
 * three commands as props, and re-renders only when a part of the input
 * changed identity (MV-D21): an update that moved nothing the view can see
 * costs no render.
 *
 * It also carries the presentation components React-drawn views share (M6):
 * `AgentIcon` (a provider's mark) and `ProfileGlyph` (a profile set's mark),
 * drawn from the toolkit's marks.
 */

import { createElement, type ComponentType } from 'react';
import { sameInputParts } from '../internal/input.js';
import { createViewRoot, releaseViewRoot } from '../internal/react-root.js';
import {
  defineMonitorView,
  type MonitorView,
  type MonitorViewCommands,
  type MonitorViewInput,
  type MonitorViewInstance,
  type MonitorViewManifest,
} from '../view.js';

export { AgentIcon, type AgentIconProps } from './AgentIcon.js';
export { ProfileGlyph, type ProfileGlyphProps } from './ProfileGlyph.js';

export interface ReactMonitorViewProps {
  readonly input: MonitorViewInput;
  readonly commands: MonitorViewCommands;
}

export interface ReactMonitorView extends MonitorView {
  /** The component the view renders. A test wraps it (`/testing`'s commit counter); a host never needs it. */
  readonly Component: ComponentType<ReactMonitorViewProps>;
  /** The root class it was built with (`ReactMonitorViewOptions`), so a wrapped copy keeps the view's styles. */
  readonly rootClass?: string | undefined;
}

export interface ReactMonitorViewOptions {
  /**
   * The class the view puts on the element `mount` is given, for as long as it is mounted there: its stylesheet's
   * scope (L18), conventionally `mv-<view id>`. Every rule of the view's CSS sits under it.
   */
  readonly rootClass?: string | undefined;
}

/** Declares a React-drawn view, refusing a manifest the contract cannot serve (`defineMonitorView`). */
export function reactMonitorView(
  manifest: MonitorViewManifest,
  Component: ComponentType<ReactMonitorViewProps>,
  options: ReactMonitorViewOptions = {},
): ReactMonitorView {
  const { rootClass } = options;
  const view: ReactMonitorView = {
    manifest,
    Component,
    ...(rootClass ? { rootClass } : {}),
    mount(element, input, commands): MonitorViewInstance {
      if (rootClass) element.classList.add(rootClass);
      const root = createViewRoot(element, manifest.id);
      let current = input;
      let live = true;
      root.render(createElement(Component, { input, commands }));
      return {
        update(next) {
          if (!live) return;
          const changed = !sameInputParts(current, next);
          current = next;
          if (changed) root.render(createElement(Component, { input: next, commands }));
        },
        unmount() {
          if (!live) return;
          live = false;
          releaseViewRoot(root);
          if (rootClass) element.classList.remove(rootClass);
        },
      };
    },
  };
  defineMonitorView(view);
  return view;
}
