import type { TimelineLane, TimelineMoment } from './timeline-lanes.js';

// What the timeline says in words: the lengths, the clock, and each body's
// readout at the head's moment. Ported from the prototype's formats
// (`draft/godview-timeline/site/tl-core.js`) and `paintWakeHeads`.

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** The swarm's own elapsed format (`bubble-model.ts`): m:ss under an hour, then hours and minutes. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / SECOND));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${pad2(hours % 24)}h`;
  if (hours > 0) return `${hours}h ${pad2(minutes % 60)}m`;
  return `${minutes}:${pad2(seconds % 60)}`;
}

/** Compact, for a span's printed length: 45s, 12m, 2h 14m. */
export function formatShort(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / SECOND));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (minutes < 1) return `${seconds}s`;
  if (hours < 1) return `${minutes}m`;
  return minutes % 60 ? `${hours}h ${pad2(minutes % 60)}m` : `${hours}h`;
}

/** Spoken, for a screen reader: "1 hour 4 minutes". */
export function formatWords(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 1) return 'under a minute';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts = [
    hours ? `${hours} hour${hours === 1 ? '' : 's'}` : '',
    rest ? `${rest} minute${rest === 1 ? '' : 's'}` : '',
  ];
  return parts.filter(Boolean).join(' ');
}

/** The wall clock, local: 14:05, or 14:05:09 for the live chip. */
export function formatClock(ms: number, withSeconds = false): string {
  const date = new Date(ms);
  const base = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return withSeconds ? `${base}:${pad2(date.getSeconds())}` : base;
}

/** A blocker kind as the readout says it; a kind the view does not know is said as itself. */
export function blockerWord(kind: string | undefined): string {
  if (kind === 'permission') return 'permission';
  if (kind === 'question') return 'question';
  if (kind === 'failure' || kind === undefined) return 'failed';
  return kind;
}

const STATE_WORD = { working: 'working', idle: 'idle', blocked: 'blocked', unseen: 'reply unseen' } as const;

/** The class a head takes, which picks its body's light and its readout's ink. */
export type ReadoutTone = 'working' | 'idle' | 'blocked' | 'unseen' | 'ended' | 'none' | 'unrecorded';

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
 * present; looking back each one says how far into that state it was and of
 * how long: `4:39` · `idle · of 7m` (TL-D13).
 */
export function readoutAt(
  lane: TimelineLane,
  moment: TimelineMoment,
  at: number,
  live: boolean,
  nowMs: number,
): TimelineReadout {
  if (moment.kind === 'unborn') return { tone: 'none', big: '', small: 'not started yet', owed: false };
  if (moment.kind === 'ended') {
    const ended = lane.endedAtMs ?? at;
    return {
      tone: 'ended',
      big: '',
      small: live ? `ended ${formatShort(nowMs - ended)} ago` : `ended at ${formatClock(ended)}`,
      owed: false,
    };
  }
  if (moment.kind === 'unrecorded') return { tone: 'unrecorded', big: '–', small: 'not recorded', owed: false };
  const span = moment.span;
  const open = span.toMs === undefined && lane.endedAtMs === undefined;
  const owed = live && open && (span.status === 'blocked' || span.status === 'unseen');
  if (lane.kind === 'terminal') {
    const running = span.status === 'working';
    return {
      tone: running ? 'working' : 'idle',
      big: running ? formatElapsed(at - span.fromMs) : '',
      small: running ? 'running' : 'quiet',
      owed: false,
    };
  }
  let word: string =
    span.status === 'blocked' ? `blocked · ${blockerWord(span.blocker?.kind)}` : STATE_WORD[span.status];
  if (!live) word += ` · of ${formatShort((span.toMs ?? nowMs) - span.fromMs)}${open ? '+' : ''}`;
  return { tone: span.status, big: formatElapsed(at - span.fromMs), small: word, owed };
}

/** A lane as a screen reader hears it, at now. */
export function laneLabel(lane: TimelineLane, nowMs: number): string {
  const agent = lane.agent;
  const where = agent.remote ? `on ${agent.remote.deviceName}, ` : '';
  const model = agent.agent ? (agent.agent.model ?? agent.agent.provider.label) : 'terminal';
  if (lane.endedAtMs !== undefined) {
    return `${where}${agent.project}, ${model}, ended ${formatWords(nowMs - lane.endedAtMs)} ago`;
  }
  const current = lane.spans[lane.spans.length - 1];
  if (!current) return `${where}${agent.project}, ${model}`;
  const length = formatWords(nowMs - current.fromMs);
  if (lane.kind === 'terminal') {
    return `${where}${agent.project}, terminal, ${current.status === 'working' ? `running for ${length}` : 'quiet'}`;
  }
  const what =
    current.status === 'blocked'
      ? `blocked on a ${blockerWord(current.blocker?.kind)} for ${length}${current.blocker?.detail ? `: ${current.blocker.detail}` : ''}`
      : `${STATE_WORD[current.status]} for ${length}`;
  return `${where}${agent.project}, ${model}, ${what}`;
}
