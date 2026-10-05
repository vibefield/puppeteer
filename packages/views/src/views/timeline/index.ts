import { MONITOR_VIEW_SDK_MAJOR, type MonitorViewManifest } from '@vibecook/puppeteer-view-sdk';
import { reactMonitorView } from '@vibecook/puppeteer-view-sdk/react';
import { TIMELINE_PARAMETER_GROUPS } from './timeline-parameters.js';
import { TimelineView } from './TimelineView.js';
// The view's own stylesheet (L18): the entry module brings it, and no host imports it.
import './timeline.css';

/** The class the view puts on the element it is mounted in: every rule of timeline.css sits under it (L18). */
export const TIMELINE_ROOT_CLASS = 'mv-timeline';

export const TIMELINE_MANIFEST: MonitorViewManifest = {
  sdk: MONITOR_VIEW_SDK_MAJOR,
  id: 'timeline',
  label: 'TIMELINE',
  // The bar's own paths (it keeps its copy until MV-8 draws marks from manifests, M12): three spans of different
  // lengths, stopping short of the now line.
  mark: { viewBox: '0 0 24 24', paths: ['M4.5 7.5h8M8 12h8.5M4.5 16.5h5', 'M19.5 4.5v15'] },
  // The ids, keys, ranges and defaults stored values were saved under: no revision, so they stay valid.
  parameters: TIMELINE_PARAMETER_GROUPS,
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
    { key: 'End', label: 'now (the map)' },
  ],
  // A clock at rest: the head follows now. The toolkit's loop stops while motion is off; a timer keeps the time.
  motion: { loops: true },
};

/** The timeline: each agent a lane from its birth, its current state up to now (runtime only), as an SDK view (MV-6). */
export const timelineMonitorView = reactMonitorView(TIMELINE_MANIFEST, TimelineView, {
  rootClass: TIMELINE_ROOT_CLASS,
});
