import {
  formatElapsed,
  formatShort,
  formatWords,
  modelWord,
  projectName,
  STATE_WORDS,
  statusWord,
  waitWord,
} from '@vibecook/puppeteer-view-sdk/toolkit';
import type { LaneSpan, TimelineLane, TimelineMoment } from './timeline-lanes.js';

// What the timeline says in words: each body's readout at the head's moment,
// and each lane as a screen reader hears it. The words and the lengths are the
// toolkit's (MV-D11), ported from this file: days from 24 hours (M14), and a
// lane's wait in the lane's own order (`laneWaitWords`, carried on the span).

/** A span's state as the readout words it: `blocked · <what it waits on>`, `reply unseen`, or the status. */
function spanWord(span: LaneSpan): string {
  if (span.status === 'blocked') return `${STATE_WORDS.status.blocked} · ${waitWord(span.wait?.kind)}`;
  if (span.status === 'unseen') return STATE_WORDS.unread.state;
  return statusWord(span.status);
}

/** The class a head takes, which picks its body's light and its readout's ink. */
export type ReadoutTone = 'working' | 'idle' | 'blocked' | 'unseen' | 'none' | 'unrecorded';

export interface TimelineReadout {
  tone: ReadoutTone;
  /** The length, large; empty when there is none to give. */
  big: string;
  /** The word beside it. */
  small: string;
  /** A wait you owe right now: the body rings (the view's one loop). */
  owed: boolean;
}

/**
 * A body's readout for the moment `at` (the head's). Following now it is the
 * present; looking back it says how far into its current state the lane was,
 * and that the state has lasted until now: `4:39` · `idle · of 7m+` (TL-D13).
 * Before its current state a lane claims nothing: `–` · `not recorded` (TL-D9).
 */
export function readoutAt(
  lane: TimelineLane,
  moment: TimelineMoment,
  at: number,
  live: boolean,
  nowMs: number,
): TimelineReadout {
  if (moment.kind === 'unborn') return { tone: 'none', big: '', small: 'not started yet', owed: false };
  if (moment.kind === 'unrecorded') return { tone: 'unrecorded', big: '–', small: 'not recorded', owed: false };
  const span = moment.span;
  if (lane.kind === 'terminal') {
    const running = span.status === 'working';
    return {
      tone: running ? 'working' : 'idle',
      big: running ? formatElapsed(at - span.fromMs) : '',
      small: running ? STATE_WORDS.terminal.running : STATE_WORDS.terminal.quiet,
      owed: false,
    };
  }
  // The span is the current state, so it is still going: a wait in it is owed now, and its length runs on.
  const owed = live && (span.status === 'blocked' || span.status === 'unseen');
  const word = live ? spanWord(span) : `${spanWord(span)} · of ${formatShort(nowMs - span.fromMs)}+`;
  return { tone: span.status, big: formatElapsed(at - span.fromMs), small: word, owed };
}

/** The line under a lane's name when it has room for two: what runs it, and its branch. */
export function laneSubLine(lane: TimelineLane): string {
  if (lane.kind !== 'agent') return '';
  return [modelWord(lane.row), lane.row.project.branch].filter(Boolean).join(' · ');
}

/** A lane as a screen reader hears it, at now. */
export function laneLabel(lane: TimelineLane, nowMs: number): string {
  const row = lane.row;
  const where = row.device.self ? '' : `on ${row.device.name}, `;
  const name = projectName(row);
  const current = lane.current;
  const length = formatWords(nowMs - current.fromMs);
  if (lane.kind === 'terminal') {
    return `${where}${name}, terminal, ${current.status === 'working' ? `running for ${length}` : 'quiet'}`;
  }
  const what =
    current.status === 'blocked'
      ? `blocked on a ${waitWord(current.wait?.kind)} for ${length}${current.wait?.detail ? `: ${current.wait.detail}` : ''}`
      : `${spanWord(current)} for ${length}`;
  return `${where}${name}, ${modelWord(row)}, ${what}`;
}
