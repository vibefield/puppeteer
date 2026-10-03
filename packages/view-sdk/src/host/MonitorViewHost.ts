/**
 * The view slot as a React component, for the two hosts' React trees.
 *
 * It renders the slot element and drives a `createViewSlot` from its layout
 * effects, so a view switch happens in the host's own commit: the old view's
 * root leaves the document and the new view mounts before the browser paints,
 * leaving no frame without a view. Commands and `onReport` always reach the
 * latest props without remounting anything.
 */

import { createElement, useLayoutEffect, useRef, type ReactElement } from 'react';
import { duringHostCommit } from '../internal/react-root.js';
import type {
  MonitorCapabilities,
  MonitorParameterValues,
  MonitorTheme,
  MonitorView,
  StageGeometry,
  ViewReport,
} from '../view.js';
import type { FrameScheduler } from './frame-scheduler.js';
import {
  createViewSlot,
  type MonitorReplicaLike,
  type ViewSlot,
  type ViewSlotCommands,
  type ViewSlotPhase,
} from './slot.js';

export interface MonitorViewHostProps {
  readonly replica: MonitorReplicaLike;
  readonly view: MonitorView;
  readonly stage: StageGeometry;
  readonly theme: MonitorTheme;
  readonly parameters: MonitorParameterValues;
  readonly capabilities?: MonitorCapabilities | undefined;
  readonly commands: ViewSlotCommands;
  readonly onReport?: ((report: ViewReport, view: MonitorView) => void) | undefined;
  readonly onError?: ((error: unknown, phase: ViewSlotPhase, view: MonitorView) => void) | undefined;
  /** Read once, at mount. */
  readonly scheduler?: FrameScheduler | undefined;
  /** The slot element's class. The host places the slot inside its stage. */
  readonly className?: string | undefined;
}

/** Every part is always given here: absent capabilities are none, never "keep the last ones". */
const NO_CAPABILITIES: MonitorCapabilities = Object.freeze({});

export function MonitorViewHost(props: MonitorViewHostProps): ReactElement {
  const { replica, view, stage, theme, parameters, className } = props;
  const capabilities = props.capabilities ?? NO_CAPABILITIES;
  const element = useRef<HTMLDivElement>(null);
  const slot = useRef<ViewSlot | null>(null);
  const latest = useRef(props);

  useLayoutEffect(() => {
    latest.current = props;
  });

  useLayoutEffect(() => {
    const initial = latest.current;
    const created = duringHostCommit(() =>
      createViewSlot(element.current!, {
        view: initial.view,
        replica: initial.replica,
        input: {
          stage: initial.stage,
          theme: initial.theme,
          parameters: initial.parameters,
          capabilities: initial.capabilities ?? NO_CAPABILITIES,
        },
        commands: {
          select: (agentId) => latest.current.commands.select(agentId),
          create: (at, target) => latest.current.commands.create(at, target),
        },
        onReport: (report, reporting) => latest.current.onReport?.(report, reporting),
        onError: (error, phase, failing) => {
          const handle = latest.current.onError;
          if (handle === undefined) throw error;
          handle(error, phase, failing);
        },
        scheduler: initial.scheduler,
      }),
    );
    slot.current = created;
    return () => {
      slot.current = null;
      duringHostCommit(() => created.dispose());
    };
  }, []);

  useLayoutEffect(() => {
    slot.current?.setInput({ stage, theme, parameters, capabilities });
  }, [stage, theme, parameters, capabilities]);

  useLayoutEffect(() => {
    const current = slot.current;
    if (current !== null) duringHostCommit(() => current.switchView(view));
  }, [view]);

  useLayoutEffect(() => {
    slot.current?.setReplica(replica);
  }, [replica]);

  return createElement('div', { ref: element, className });
}
