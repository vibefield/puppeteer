import { MONITOR_VIEW_SDK_MAJOR, type MonitorViewManifest } from '@vibecook/puppeteer-view-sdk';
import { reactMonitorView } from '@vibecook/puppeteer-view-sdk/react';
import { AgentList } from './AgentList.js';
import { LIST_PARAMETER_GROUPS } from './list-parameters.js';
// The view's own stylesheet (L18): the entry module brings it, and no host imports it.
import './list.css';

/** The class the view puts on the element it is mounted in: every rule of list.css sits under it (L18). */
export const LIST_ROOT_CLASS = 'mv-list';

export const LIST_MANIFEST: MonitorViewManifest = {
  sdk: MONITOR_VIEW_SDK_MAJOR,
  id: 'list',
  label: 'LIST',
  // The bar's own path (it keeps its copy until MV-8 draws marks from manifests, M12).
  mark: { viewBox: '0 0 24 24', paths: ['M5 7h14M5 12h14M5 17h14'] },
  // The ids, keys, ranges and defaults stored values were saved under: no revision, so they stay valid.
  parameters: LIST_PARAMETER_GROUPS,
  // `＋ TERMINAL` offers the spawn menu's two steps when there is one; without it, a press creates at once.
  capabilities: { optional: ['spawn'] },
  // Nothing loops at rest: its only motion is the stylesheet's transitions.
  motion: { loops: false },
};

/** The list: a non-spatial reading of the agents, ordered by attention, as an SDK view (MV-4). */
export const listMonitorView = reactMonitorView(LIST_MANIFEST, AgentList, { rootClass: LIST_ROOT_CLASS });
