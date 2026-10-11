import type { EndedLaneView, MonitorPastSpan } from '@vibecook/puppeteer-view-sdk';
import {
  formatClock,
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
// A moment the record holds is said as the record can say it (T1): worked as
// work, quiet as quiet; inside its bounds alone the detail was not recorded.
// Never blocked, never unseen.

/** What the record's bounds alone say about a moment inside them (the floor, T5): it was active, the detail unknown. */
export const BOUNDS_WORDS = 'detail not recorded';

/** A span's state as the readout words it: `blocked · <what it waits on>`, `reply unseen`, or the status. */
function spanWord(span: LaneSpan): string {
  if (span.status === 'blocked') return `${STATE_WORDS.status.blocked} · ${waitWord(span.wait?.kind)}`;
  if (span.status === 'unseen') return STATE_WORDS.unread.state;
  return statusWord(span.status);
}

/** The class a head takes, which picks its body's light and its readout's ink. */
export type ReadoutTone = 'working' | 'idle' | 'blocked' | 'unseen' | 'none' | 'unrecorded' | 'bounds' | 'ended';

export interface TimelineReadout {
  tone: ReadoutTone;
  /** The length, large; empty when there is none to give. */
  big: string;
  /** The word beside it. */
  small: string;
  /** A wait you owe right now: the body rings (the view's one loop). */
  owed: boolean;
  /** Said from the record (a past moment, or an ended run): its words may take a second line rather than be cut. */
  recorded?: true;
}

/**
 * A recorded moment's readout: a worked stretch as a working span reads (how far in, and of how long, closed), a
 * quiet one as `quiet`, the bounds alone as what they are.
 */
function recordedReadout(span: MonitorPastSpan, at: number, live: boolean): TimelineReadout {
  if (span.kind === 'worked') {
    const word = statusWord('working');
    return {
      tone: 'working',
      big: formatElapsed(at - span.from),
      small: live ? word : `${word} · of ${formatShort(span.to - span.from)}`,
      owed: false,
      recorded: true,
    };
  }
  if (span.kind === 'quiet') return { tone: 'idle', big: '', small: 'quiet', owed: false, recorded: true };
  return { tone: 'bounds', big: '–', small: BOUNDS_WORDS, owed: false, recorded: true };
}

/**
 * A body's readout for the moment `at` (the head's). Following now it is the
 * present; looking back it says how far into its current state the lane was,
 * and that the state has lasted until now: `4:39` · `idle · of 7m+` (TL-D13).
 * Before its current state a lane has only its record: a recorded moment says
 * what the record says, and anything else `–` · `not recorded` (TL-D9). Past
 * an ended run's last activity it says when it was last active (the record
 * holds no exit; the faint lane and its end tick already say it ended).
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
  if (moment.kind === 'past') return recordedReadout(moment.span, at, live);
  if (moment.kind === 'ended') {
    const last = lane.ended?.endedAt ?? at;
    return {
      tone: 'ended',
      big: '',
      small: `last active ${live ? `${formatShort(nowMs - last)} ago` : formatClock(last)}`,
      owed: false,
      recorded: true,
    };
  }
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

/**
 * The record's state as a narrow head says it, in SINCE's words, where its sentence will not fit: partial or not
 * readable now. A whole record says nothing.
 */
export function recordState(state: 'complete' | 'partial' | 'unavailable'): string {
  if (state === 'partial') return 'RECORD PARTIAL';
  return state === 'unavailable' ? 'NO RECORD NOW' : '';
}

/** An ended run's name: its title, else what ran it and where (its provider's label · its project). */
export function endedName(run: Pick<EndedLaneView, 'title' | 'provider' | 'project'>): string {
  return run.title || [run.provider?.label, run.project.name].filter(Boolean).join(' · ');
}

/** A lane's name, as its name column prints it: a row's project, or an ended run's own name. */
export function laneName(lane: TimelineLane): string {
  return lane.ended === undefined ? projectName(lane.row) : endedName(lane.ended);
}

/**
 * The line under a lane's name when it has room for two: what runs it, and its branch. An ended run has no model,
 * so its provider stands there, unless its name already says it.
 */
export function laneSubLine(lane: TimelineLane): string {
  if (lane.kind !== 'agent') return '';
  if (lane.ended !== undefined) {
    const run = lane.ended;
    return [run.title ? run.provider?.label : undefined, run.project.branch].filter(Boolean).join(' · ');
  }
  return [modelWord(lane.row), lane.row.project.branch].filter(Boolean).join(' · ');
}

/** What an ended run's button adds to its line where the host can open it (TV-8): where a press takes you. */
export const OPENS_IN_HISTORY = 'opens in History';

/** A lane as a screen reader hears it, at now. */
export function laneLabel(lane: TimelineLane, nowMs: number): string {
  if (lane.ended !== undefined) {
    const run = lane.ended;
    const where = run.device.self ? '' : `on ${run.device.name}, `;
    const who = [run.title, run.project.name, run.provider?.label].filter(Boolean).join(', ');
    return `${where}${who}, ended, last active ${formatWords(nowMs - run.endedAt)} ago`;
  }
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
