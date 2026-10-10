import { MONITOR_VIEW_SDK_MAJOR, type MonitorViewManifest } from '@vibecook/puppeteer-view-sdk';
import { reactMonitorView } from '@vibecook/puppeteer-view-sdk/react';
import { MARK_VIEW_BOX, strokeOutline, strokesOutline } from '@vibecook/puppeteer-view-sdk/toolkit';
import { TIMELINE_PARAMETER_GROUPS } from './timeline-parameters.js';
import { NOW_KEY, TimelineView } from './TimelineView.js';
// The view's own stylesheet (L18): the entry module brings it, and no host imports it.
import './timeline.css';

/** The class the view puts on the element it is mounted in: every rule of timeline.css sits under it (L18). */
export const TIMELINE_ROOT_CLASS = 'mv-timeline';

export const TIMELINE_MANIFEST: MonitorViewManifest = {
  sdk: MONITOR_VIEW_SDK_MAJOR,
  id: 'timeline',
  label: 'TIMELINE',
  // Three spans of different lengths, stopping short of the now line: the filled outlines of the bar's 1.6 strokes,
  // since the bar fills a mark (MV-D6).
  mark: {
    viewBox: MARK_VIEW_BOX,
    paths: [
      strokesOutline([
        [
          [4.5, 7.5],
          [12.5, 7.5],
        ],
        [
          [8, 12],
          [16.5, 12],
        ],
        [
          [4.5, 16.5],
          [9.5, 16.5],
        ],
      ]),
      strokeOutline([19.5, 4.5], [19.5, 19.5]),
    ],
  },
  // The ids, keys, ranges and defaults stored values were saved under: no revision, so they stay valid.
  parameters: TIMELINE_PARAMETER_GROUPS,
  // The record's past (T0): the declaration is the ask. A host with a record reads the view's day while it is mounted;
  // one without lends nothing, and the timeline draws runtime state alone.
  capabilities: { optional: ['history'] },
  // Bound on the lanes and the map only while one of them holds focus (MV-D8; TL: none new on the frame).
  keys: [
    { key: 'ArrowUp', label: 'light the lane above' },
    { key: 'ArrowDown', label: 'light the lane below' },
    { key: 'Enter', label: 'open the lit lane' },
    { key: 'ArrowLeft', label: 'back in time' },
    { key: 'ArrowRight', label: 'on toward now' },
    { key: '-', label: 'zoom out' },
    { key: '=', label: 'zoom in' },
    { key: 'Home', label: 'the start of the day (the map)' },
    { key: NOW_KEY, label: 'now (the map)' },
  ],
  // A clock at rest: the head follows now. The toolkit's loop stops while motion is off; a timer keeps the time.
  motion: { loops: true },
};

/**
 * The timeline: each agent a lane from its birth, its current state up to now, and before it what the record says
 * when the host lends it (`history`), as an SDK view (MV-6).
 */
export const timelineMonitorView = reactMonitorView(TIMELINE_MANIFEST, TimelineView, {
  rootClass: TIMELINE_ROOT_CLASS,
});
