import type { AgentView } from '@vibefield/puppeteer-view-sdk';
import { detailLine, formatClock, formatShort, formatUsd, projectName } from '@vibefield/puppeteer-view-sdk/toolkit';

// What the spend view says in words: money as the swarm prints it (`~$1.84`,
// `+` when partial, `—` unpriced), the burn by the hour, each row's name and
// the line under it, and its state at a moment. Lengths are short (`11m`, `1h 02m`), never
// m:ss, which beside a time axis would read as a clock time (review must-fix 5).
// Ported from the prototype's `SV.fmt`, `names()`, `fitWords()` and `stateOf()`;
// the facts are the row's (MV-7), the formats the toolkit's.

/** The toolkit's `formatUsd`, with thousands as whole dollars. */
export function money(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 1000) return `$${Math.round(value).toLocaleString('en-US')}`;
  return formatUsd(value);
}

/** The swarm's own figure: a tilde because it is an estimate, a plus when some work went unpriced. */
export const est = (value: number | undefined, partial: boolean): string =>
  value === undefined ? '—' : `~${money(value)}${partial ? '+' : ''}`;

/** The burn as people price work, by the hour (the toolkit's `formatRatePerHour`, from USD a minute). */
export function perHour(perMinute: number | undefined): string {
  if (perMinute === undefined) return '—/hr';
  const hour = perMinute * 60;
  if (hour >= 10) return `$${Math.round(hour)}/hr`;
  if (hour >= 1) return `$${hour.toFixed(1)}/hr`;
  if (hour <= 0) return '$0/hr';
  return `${money(hour)}/hr`;
}

/** An axis tick, as short as the step allows. */
export function axisMoney(value: number, step: number): string {
  if (value === 0) return '$0';
  if (step >= 1) return `$${Math.round(value).toLocaleString('en-US')}`;
  if (step >= 0.1) return `$${value.toFixed(1)}`;
  if (step >= 0.01) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(3)}`;
}

/** Below this a working agent's burn is said as how long it has worked. */
const BURN_FLOOR_PER_MIN = 0.0005;

/**
 * What a row says where the held view printed its task: the line under its
 * name, by the toolkit's one rule (M4's `detailLine`: the wait when blocked,
 * else the reply, else the status; a peer leads with its desktop), its first
 * line, unless it only repeats the project or the bare status the row's state
 * words already print: then nothing, and the row falls back to its model, as
 * the held view's did. The task itself is no model fact: the held view read
 * the terminal's title, and a title crossing devices is a sync-plane change
 * (M178).
 */
export function taskOf(agent: AgentView): string {
  const line = detailLine(agent)
    .split('\n')[0]!
    .replace(/^[^\p{L}\p{N}~/.]+/u, '')
    .trim();
  return line && line !== projectName(agent) && line !== agent.status ? line : '';
}

/** The model the tooltip names: the run's model (or its provider), then its branch. */
export function modelOf(agent: AgentView): string {
  return [agent.model ?? agent.provider?.label, agent.project.branch].filter(Boolean).join(' · ');
}

export interface SpendName {
  /** Its project, as the swarm names a body. */
  readonly name: string;
  /** The one-line form: the project, and what tells siblings apart. */
  readonly one: string;
  readonly task: string;
  readonly model: string;
}

const firstWords = (text: string, count: number): string => text.split(/\s+/).slice(0, count).join(' ');

/**
 * The names rows go by. Where two share a project the one-line form adds what
 * tells them apart: their agent when it differs, else the first words of their
 * task; the two-line form puts the task on the second line (review must-fix 1).
 */
export function spendNames(agents: readonly AgentView[]): Map<string, SpendName> {
  const out = new Map<string, SpendName>();
  for (const agent of agents) {
    const task = taskOf(agent);
    const project = projectName(agent);
    const siblings = agents.filter((other) => other !== agent && projectName(other) === project);
    const provider = agent.provider?.id ?? '';
    const sameProvider = siblings.some((other) => (other.provider?.id ?? '') === provider);
    const one = siblings.length
      ? `${project} · ${sameProvider || !provider ? firstWords(task, 2) || agent.id : provider}`
      : project;
    out.set(agent.id, { name: project, one, task, model: modelOf(agent) });
  }
  return out;
}

/** Text fitted to a width at a word boundary, so a cut never lands mid-word. */
export function fitWords(text: string, max: number, measure: (text: string) => number): string {
  if (!text || max <= 0) return '';
  if (measure(text) <= max) return text;
  let out = '';
  for (const word of text.split(' ')) {
    const next = out ? `${out} ${word}` : word;
    if (measure(`${next}…`) > max) break;
    out = next;
  }
  return out ? `${out}…` : '';
}

export type SpendStateKey = 'before' | 'working' | 'blocked' | 'unseen' | 'idle' | 'unknown';
export type SpendGlyph = 'question' | 'failure' | 'permission' | 'reply';

export interface SpendState {
  readonly key: SpendStateKey;
  /** When this state began (for `before`, when it will). */
  readonly sinceMs: number;
  readonly glyph?: SpendGlyph | undefined;
  /** What it waits on, for the tooltip. */
  readonly words?: string | undefined;
}

/** What a row needs for its state: the live row, and when it was born. */
export interface SpendStateRow {
  readonly agent: AgentView;
  readonly bornMs: number;
}

const glyphOf = (kind: string | undefined): SpendGlyph =>
  kind === 'question' ? 'question' : kind === 'failure' ? 'failure' : 'permission';

/**
 * What a row was doing at `t`, as far as the live row says. Before it was
 * born it is not yet anything: it says when it starts (round 2, SV-D15). From
 * the moment its current state began (`statusSince`) it is that state, a reply
 * nobody opened being `unseen`. Earlier than that the row does not say, and
 * the view keeps no record (runtime only): `unknown`.
 */
export function spendStateAt(row: SpendStateRow, t: number, nowMs: number): SpendState {
  if (t < row.bornMs) return { key: 'before', sinceMs: row.bornMs };
  const statusSince = row.agent.statusSince;
  const sinceMs = Number.isFinite(statusSince) ? Math.max(row.bornMs, Math.min(statusSince, nowMs)) : row.bornMs;
  if (t < sinceMs && t < nowMs - 1000) return { key: 'unknown', sinceMs: t };
  const status = row.agent.status === 'idle' && row.agent.unread ? 'unseen' : row.agent.status;
  if (status === 'blocked') {
    const wait = row.agent.wait;
    return { key: 'blocked', sinceMs, glyph: glyphOf(wait?.kind), words: wait?.detail };
  }
  if (status === 'unseen') return { key: 'unseen', sinceMs, glyph: 'reply' };
  return { key: status, sinceMs };
}

export type SpendTone = 'live' | 'attention' | 'info' | 'muted';

/**
 * The burn a row prints at a moment, per minute: a working row's, or — before
 * its current state began, which the row does not say — what the buckets show
 * it spending then. Undefined when its words say something else, or the burn
 * is too small to print. The hero adds exactly these (review must-fix 2).
 */
export function printedBurn(state: SpendState, perMinute: number | undefined): number | undefined {
  if (state.key !== 'working' && state.key !== 'unknown') return undefined;
  return perMinute !== undefined && perMinute > BURN_FLOOR_PER_MIN ? perMinute : undefined;
}

/** A state's words for line 2 (or the money slot, for `before` in the one-line form), and their tone (§2.5). */
export function stateWords(
  state: SpendState,
  t: number,
  perMinute: number | undefined,
): { text: string; tone: SpendTone } {
  const since = formatShort(t - state.sinceMs);
  const burn = printedBurn(state, perMinute);
  switch (state.key) {
    case 'before':
      return { text: `starts ${formatClock(state.sinceMs)}`, tone: 'muted' };
    case 'blocked':
      return { text: `waiting · ${since}`, tone: 'attention' };
    case 'unseen':
      return { text: `reply unseen · ${since}`, tone: 'info' };
    case 'idle':
      return { text: `idle · ${since}`, tone: 'muted' };
    case 'working':
      return { text: burn !== undefined ? perHour(burn) : `working · ${since}`, tone: 'live' };
    default:
      // Before its current state began: what it was doing nobody kept, what it was spending its buckets say.
      return burn !== undefined ? { text: perHour(burn), tone: 'live' } : { text: '', tone: 'muted' };
  }
}

/** A started row whose money then nobody recorded: another desktop's row carries its total, never its buckets. */
export const NOT_RECORDED: { readonly text: string; readonly tone: SpendTone } = {
  text: 'not recorded',
  tone: 'muted',
};

/** A row that waits on the person: it never folds out of sight (SV-D19 docks it). */
export const waits = (state: SpendState): boolean => state.key === 'blocked' || state.key === 'unseen';
