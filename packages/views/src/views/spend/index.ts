import { MONITOR_VIEW_SDK_MAJOR, type MonitorViewManifest } from '@vibecook/puppeteer-view-sdk';
import { reactMonitorView } from '@vibecook/puppeteer-view-sdk/react';
import { MARK_VIEW_BOX, strokeOutline, strokesOutline } from '@vibecook/puppeteer-view-sdk/toolkit';
import { SPEND_PARAMETER_GROUPS } from './spend-parameters.js';
import { SpendView } from './SpendView.js';
// The view's own stylesheet (L18): the entry module brings it, and no host imports it.
import './spend.css';

/** The class the view puts on the element it is mounted in: every rule of spend.css sits under it (L18). */
export const SPEND_ROOT_CLASS = 'mv-spend';

export const SPEND_MANIFEST: MonitorViewManifest = {
  sdk: MONITOR_VIEW_SDK_MAJOR,
  id: 'spend',
  label: 'SPEND',
  // A line climbing to a now line, its head a dot: the filled outlines of the bar's 1.6 strokes, since the bar fills a
  // mark (MV-D6), and the dot a stroke of no length, as wide as the held mark's disc (r 2.2).
  mark: {
    viewBox: MARK_VIEW_BOX,
    paths: [
      strokesOutline([
        [
          [3.5, 18.5],
          [8, 14],
        ],
        [
          [8, 14],
          [11.5, 16.5],
        ],
        [
          [11.5, 16.5],
          [17, 9],
        ],
      ]),
      strokeOutline([20.5, 4], [20.5, 20]),
      strokeOutline([17, 9], [17, 9], 4.4),
    ],
  },
  parameters: SPEND_PARAMETER_GROUPS,
  // The tunables were decided on this date (SV, `238d0a6`): the view starts from its own defaults, never the legacy
  // seed an unrevised view reads.
  parametersRevision: '2026-10-03',
  // Bound on the view's root only while it holds focus (MV-D8; the few-keys round kept these four, SV review 11).
  keys: [
    { key: 'ArrowUp', label: 'the agent above' },
    { key: 'ArrowDown', label: 'the agent below' },
    { key: 'Enter', label: 'open the agent in your pane' },
    { key: 'End', label: 'let go of a set moment (Now)' },
  ],
  // A clock at rest: now moves along the axis, and a waiting head's wave runs on the toolkit's loop. Motion off, the
  // loop asks for no frame and nothing eases or glides; the clock still keeps the time.
  motion: { loops: true },
};

/** Where the money went: what each agent spent in the last ten minutes, a line each from $0, as an SDK view (MV-7). */
export const spendMonitorView = reactMonitorView(SPEND_MANIFEST, SpendView, { rootClass: SPEND_ROOT_CLASS });
