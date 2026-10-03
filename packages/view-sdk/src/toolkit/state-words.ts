import type { AgentStatus, MonitorAgentRow } from '../model.js';

// THE SHARED STATE WORDS AND TONES (MV-D11): one table for how every view says
// what a row is doing — its status, what it waits on, a reply nobody has
// read, and how far it steps back when the host shows another group.
//
// Every word is ported verbatim from the view that says it today (the
// timeline's readouts, the swarm's bodies, the list's and the rain's labels,
// the bar's counters), so a view moved onto the SDK says exactly what it said
// before. The backend words the row's own line (`MonitorAgentRow.detail`);
// these are the words a view puts around it.

/** The shared words, grouped by what they name. */
export const STATE_WORDS = {
  /** A status as a row says it. The bar prints the same three in capitals. */
  status: { idle: 'idle', working: 'working', blocked: 'blocked' },
  /** A bare terminal says what its foreground job is doing, never a status. */
  terminal: { running: 'running', quiet: 'quiet', empty: 'empty', opening: 'opening' },
  /** What a blocked row waits on, by the runtime's own kind. */
  wait: { permission: 'permission', question: 'question', failure: 'failed' },
  /** A finished turn nobody has looked at: the state's name, and the line a
   * body says when the reply carried no text to quote. */
  unread: { state: 'reply unseen', line: 'new message' },
  /** What a row that is not an agent is, where a model's name would stand. */
  kind: { terminal: 'terminal', remote: 'remote session' },
} as const;

/** The wait kinds the runtime names today. `MonitorWait.kind` stays open: a new one is said as itself. */
export type KnownWaitKind = keyof typeof STATE_WORDS.wait;

/** The mark a wait asks with: the icon a body draws before its words. */
export const WAIT_MARKS: Readonly<Record<KnownWaitKind, string>> = {
  permission: 'permission',
  question: 'question',
  failure: 'failure',
};

function isKnownWaitKind(kind: string | undefined): kind is KnownWaitKind {
  return kind === 'permission' || kind === 'question' || kind === 'failure';
}

export function statusWord(status: AgentStatus): string {
  return STATE_WORDS.status[status];
}

/** A wait as a readout says it: a kind the toolkit does not know is said as itself; none at all reads as a failure. */
export function waitWord(kind: string | undefined): string {
  if (kind === undefined) return STATE_WORDS.wait.failure;
  return isKnownWaitKind(kind) ? STATE_WORDS.wait[kind] : kind;
}

/** The mark a wait asks with; a kind the toolkit does not know asks with the failure's. */
export function waitMark(kind: string | undefined): string {
  return isKnownWaitKind(kind) ? WAIT_MARKS[kind] : WAIT_MARKS.failure;
}

/** A terminal that is opening says so, and where when it is another desktop: `opening`, `opening on mini`. */
export function openingWord(on?: string): string {
  return on ? `${STATE_WORDS.terminal.opening} on ${on}` : STATE_WORDS.terminal.opening;
}

/** The unread line a screen reader hears: `new message`, or `new message: <the reply>`. */
export function unreadSpoken(reply?: string): string {
  return reply ? `${STATE_WORDS.unread.line}: ${reply}` : STATE_WORDS.unread.line;
}

/**
 * Which light a row's state takes; the palette resolves each one
 * (`MonitorPalette`). Status comes first: a blocked row is blocked and a
 * working one working, whatever else is true of it. Idle with a reply nobody
 * has read is `unread` — an agent's only, since a terminal has no turns.
 */
export type StateTone = 'working' | 'blocked' | 'unread' | 'idle';

export function stateTone(row: Pick<MonitorAgentRow, 'kind' | 'status' | 'unread'>): StateTone {
  if (row.status === 'blocked') return 'blocked';
  if (row.status === 'working') return 'working';
  return row.kind === 'agent' && row.unread ? 'unread' : 'idle';
}

/**
 * The word for a row's state, as the timeline's readout says it now: a
 * terminal is `running` or `quiet`; an agent `working`, `idle`, `reply
 * unseen`, or `blocked · <what it waits on>`.
 */
export function stateWord(row: Pick<MonitorAgentRow, 'kind' | 'status' | 'unread' | 'wait'>): string {
  if (row.kind === 'terminal') {
    return row.status === 'working' ? STATE_WORDS.terminal.running : STATE_WORDS.terminal.quiet;
  }
  switch (stateTone(row)) {
    case 'blocked':
      return `${STATE_WORDS.status.blocked} · ${waitWord(row.wait?.kind)}`;
    case 'unread':
      return STATE_WORDS.unread.state;
    default:
      return statusWord(row.status);
  }
}

// RECEDING (Godview's profile tabs): a host that shows one group keeps every
// other row on the stage — in its place, in the physics, in the list — drawn
// faint. These are the steps every view recedes by and the one rate the canvas
// views animate with; a stylesheet that recedes the same rows repeats them.

/** A receded row's weight while the shown ones are on the stage. */
export const RECEDED_OPACITY = 0.22;
/** Every row receded: the host has a sentence to say over the stage, so the rest step further back. */
export const RECEDED_EMPTY_OPACITY = 0.07;
/** How long a row takes to recede, or to come back. */
export const RECEDE_MS = 240;

/** Every row is receded: nothing the host chose is on the stage. False for no rows. */
export function everyReceded(rows: Iterable<{ readonly receded?: boolean | undefined }>): boolean {
  let any = false;
  for (const row of rows) {
    if (row.receded !== true) return false;
    any = true;
  }
  return any;
}

/** The weight a row is drawn at once it has settled: 1 when it is shown. */
export function recedeTarget(receded: boolean, every: boolean): number {
  if (!receded) return 1;
  return every ? RECEDED_EMPTY_OPACITY : RECEDED_OPACITY;
}

/** One frame's step toward the target: linear, the whole way back from 22 % in `RECEDE_MS`. */
export function approachRecede(current: number, target: number, deltaMs: number): number {
  const rate = ((1 - RECEDED_OPACITY) * Math.max(0, deltaMs)) / RECEDE_MS;
  if (Math.abs(target - current) <= rate) return target;
  return current + Math.sign(target - current) * rate;
}
