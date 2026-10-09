/**
 * The record's past as a host lends it to a view (capability `history`): the
 * backend's snapshot, each ended lane coloured with the theme's colour function
 * the replica colours rows with (L7), so an ended lane and a live one in the
 * same project wear the same ink and the view deals none itself.
 */

import type { MonitorPastSnapshot } from '../model.js';
import type { EndedLaneView, MonitorHistory } from '../view.js';

/** `past`, its ended lanes coloured by `colourFor` (the replica's theme function: a sequence, or the neutral ramp). */
export function lendHistory(past: MonitorPastSnapshot, colourFor: (seq: number | undefined) => string): MonitorHistory {
  const ended: EndedLaneView[] = past.ended.map((lane) =>
    Object.freeze({ ...lane, colour: colourFor(lane.project.seq) }),
  );
  return Object.freeze({ ...past, ended: Object.freeze(ended) });
}
