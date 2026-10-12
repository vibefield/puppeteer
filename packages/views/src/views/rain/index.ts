import { MONITOR_VIEW_SDK_MAJOR, type MonitorViewManifest } from '@vibefield/puppeteer-view-sdk';
import { reactMonitorView } from '@vibefield/puppeteer-view-sdk/react';
import { MARK_VIEW_BOX, strokesOutline } from '@vibefield/puppeteer-view-sdk/toolkit';
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
  // Three broken columns, as the filled outlines of the bar's 1.6 strokes: the bar fills a mark (MV-D6).
  mark: {
    viewBox: MARK_VIEW_BOX,
    paths: [
      strokesOutline([
        [
          [7, 4],
          [7, 9],
        ],
        [
          [7, 12.5],
          [7, 15],
        ],
        [
          [12, 3],
          [12, 5.5],
        ],
        [
          [12, 8.5],
          [12, 16.5],
        ],
        [
          [17, 5],
          [17, 8.5],
        ],
        [
          [17, 12],
          [17, 18],
        ],
      ]),
    ],
  },
  // The ids, keys, ranges and defaults stored values were saved under: no revision, so they stay valid.
  parameters: RAIN_PARAMETER_GROUPS,
  // The stream falls while it is shown: a loop at rest, which the toolkit stops when motion is off.
  motion: { loops: true },
};

/** The rain: each agent a column of its own words, falling at its status's pace, as an SDK view (MV-4). */
export const rainMonitorView = reactMonitorView(RAIN_MANIFEST, RainView, { rootClass: RAIN_ROOT_CLASS });
