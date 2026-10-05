import type { MonitorView } from '@vibecook/puppeteer-view-sdk';
import { listMonitorView } from '../views/list/index.js';
import { rainMonitorView } from '../views/rain/index.js';
import { swarmMonitorView } from '../views/swarm/index.js';
import { timelineMonitorView } from '../views/timeline/index.js';
import type { MonitorViewEntry, PortedMonitorView } from './types.js';

/** A ported view's registry face, read from its manifest. */
export function portedMonitorView(view: MonitorView): PortedMonitorView {
  const { id, label, parameters, parametersRevision } = view.manifest;
  return {
    id,
    label,
    parameterGroups: parameters,
    ...(parametersRevision === undefined ? {} : { parametersRevision }),
    view,
  };
}

/** Whether a host mounts the entry's own SDK view (true) or its legacy component through the bridge. */
export function isPortedMonitorView(entry: MonitorViewEntry): entry is PortedMonitorView {
  return 'view' in entry;
}

/**
 * Every way of looking at the running agents. A new view is one directory under
 * `views/` and one entry here — the same shape `createBuiltinProviders` gives
 * agent providers in packages/runtime. List and rain are SDK views (MV-4); the
 * swarm and the timeline still mount through the legacy bridge.
 */
export const MONITOR_VIEWS: readonly MonitorViewEntry[] = [
  swarmMonitorView,
  portedMonitorView(listMonitorView),
  portedMonitorView(rainMonitorView),
  timelineMonitorView,
];

export const DEFAULT_MONITOR_VIEW_ID = swarmMonitorView.id;

/** Falls back to the default, so a stored id from a removed view cannot strand the window. */
export function monitorViewFor(id: string | null | undefined): MonitorViewEntry {
  return MONITOR_VIEWS.find((view) => view.id === id) ?? MONITOR_VIEWS[0]!;
}
