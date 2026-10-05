import { MONITOR_VIEW_SDK_MAJOR, type MonitorViewManifest } from '@vibecook/puppeteer-view-sdk';
import { reactMonitorView } from '@vibecook/puppeteer-view-sdk/react';
import { MARK_VIEW_BOX, ringOutline } from '@vibecook/puppeteer-view-sdk/toolkit';
import { AgentSwarm } from './AgentSwarm.js';
import { SWARM_PARAMETER_GROUPS } from './swarm-parameters.js';
// The view's own stylesheets (L18): the entry module brings them, and no host imports them.
import './swarm.css';
import './bloom/spawn-bloom.css';

/** The class the view puts on the element it is mounted in: every rule of swarm.css and spawn-bloom.css sits under it (L18). */
export const SWARM_ROOT_CLASS = 'mv-swarm';

export const SWARM_MANIFEST: MonitorViewManifest = {
  sdk: MONITOR_VIEW_SDK_MAJOR,
  id: 'swarm',
  label: 'SWARM',
  // Three bodies: the rings the bar's 1.6 strokes drew, as filled outlines, since the bar fills a mark (MV-D6).
  mark: {
    viewBox: MARK_VIEW_BOX,
    paths: [ringOutline(7.5, 8, 3), ringOutline(16, 6.5, 2.2), ringOutline(13, 16, 4.2)],
  },
  parameters: SWARM_PARAMETER_GROUPS,
  // The design was locked on this date (RFC 005, record §10) with new sizes and lights; installations tuned under
  // the proposals start from the lock, and every stored value since stays valid under it.
  parametersRevision: '2026-09-09',
  // With a spawn menu a hold blooms (SB); without one it creates at once, as it always has.
  capabilities: { optional: ['spawn'] },
  // The spawn bloom's keys, taken only while the view is focused (MV-D8): a hold's bloom hears ⎋ on the field; a
  // bloom held open, or the keys door's, hears the rest on its menu.
  keys: [
    { key: 'Escape', label: 'put the bloom away' },
    { key: 'Enter', label: 'open where the bloom points' },
    { key: 'ArrowRight', label: 'the next bud' },
    { key: 'ArrowLeft', label: 'the bud before' },
  ],
  // The field is alive at rest: the physics settle and the bodies breathe. The toolkit's loop stops it when motion
  // is off, and the physics pause with it.
  motion: { loops: true },
};

/** The swarm: the matter.js agent field drawn by WebGPU (RFC 005), as an SDK view (MV-5). */
export const swarmMonitorView = reactMonitorView(SWARM_MANIFEST, AgentSwarm, { rootClass: SWARM_ROOT_CLASS });
