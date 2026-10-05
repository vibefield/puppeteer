import { MONITOR_VIEW_SDK_MAJOR, type MonitorViewManifest } from '@vibecook/puppeteer-view-sdk';
import { reactMonitorView } from '@vibecook/puppeteer-view-sdk/react';
import { RAIN_PARAMETER_GROUPS } from './rain-parameters.js';
import { RainView } from './RainView.js';
// The view's own stylesheet (L18): the entry module brings it, and no host imports it.
import './rain.css';

/** The class the view puts on the element it is mounted in: every rule of rain.css sits under it (L18). */
export const RAIN_ROOT_CLASS = 'mv-rain';

export const RAIN_MANIFEST: MonitorViewManifest = {
  sdk: MONITOR_VIEW_SDK_MAJOR,
  id: 'rain',
  label: 'RAIN',
  // The bar's own path (it keeps its copy until MV-8 draws marks from manifests, M12).
  mark: { viewBox: '0 0 24 24', paths: ['M7 4v5M7 12.5v2.5M12 3v2.5M12 8.5v8M17 5v3.5M17 12v6'] },
  // The ids, keys, ranges and defaults stored values were saved under: no revision, so they stay valid.
  parameters: RAIN_PARAMETER_GROUPS,
  // The stream falls while it is shown: a loop at rest, which the toolkit stops when motion is off.
  motion: { loops: true },
};

/** The rain: each agent a column of its own words, falling at its status's pace, as an SDK view (MV-4). */
export const rainMonitorView = reactMonitorView(RAIN_MANIFEST, RainView, { rootClass: RAIN_ROOT_CLASS });
