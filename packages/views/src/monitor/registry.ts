import type { MonitorView } from '@vibecook/puppeteer-view-sdk';
import { listMonitorView } from '../views/list/index.js';
import { rainMonitorView } from '../views/rain/index.js';
import { swarmMonitorView } from '../views/swarm/index.js';
import { timelineMonitorView } from '../views/timeline/index.js';
import type { MonitorViewEntry } from './types.js';

/** A view's registry face, read from its manifest. */
export function monitorViewEntry(view: MonitorView): MonitorViewEntry {
  const { id, label, mark, keys, parameters, parametersRevision } = view.manifest;
  return {
    id,
    label,
    mark,
    ...(keys === undefined ? {} : { keys }),
    parameterGroups: parameters,
    ...(parametersRevision === undefined ? {} : { parametersRevision }),
    view,
  };
}

/**
 * Every way of looking at the running agents. A new view is one directory under
 * `views/` and one entry here — the same shape `createBuiltinProviders` gives
 * agent providers in packages/runtime. Every one is an SDK view (MV-4, MV-5, MV-6).
 */
export const MONITOR_VIEWS: readonly MonitorViewEntry[] = [
  monitorViewEntry(swarmMonitorView),
  monitorViewEntry(listMonitorView),
  monitorViewEntry(rainMonitorView),
  monitorViewEntry(timelineMonitorView),
];

export const DEFAULT_MONITOR_VIEW_ID = swarmMonitorView.manifest.id;

/** Falls back to the default, so a stored id from a removed view cannot strand the window. */
export function monitorViewFor(id: string | null | undefined): MonitorViewEntry {
  return MONITOR_VIEWS.find((view) => view.id === id) ?? MONITOR_VIEWS[0]!;
}
