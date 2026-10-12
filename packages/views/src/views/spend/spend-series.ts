import type { AgentView } from '@vibefield/puppeteer-view-sdk';

// The spend view's lines ("Where the Money Went", SV; design B, Watchlist,
// `draft/godview-spend/` §B′). Runtime only (James, 2026-10-03): a line is
// drawn from what the live row says now and nothing else, the backend's
// `MonitorCost` on it (MV-7) —
//
//   its meter, the run's estimated API-equivalent USD (`cost.usd`);
//   Core's last ten minutes, twenty 30-second buckets (`cost.series`, oldest
//   first, the last the bucket now is in, begun at `series.lastStepAt`).
//
// The meter at a bucket's start is the total less every bucket that began at
// or after it: that is the agent's actual meter, whose head is the live total
// its row prints. The chart draws what each spent IN THE WINDOW (James,
// 2026-10-03; the totals lay nearly flat on one scale): the meter less what it
// read where the window begins for it — the window's start, or its birth — so
// every line starts at $0 and the busy ones climb. Another desktop's row has no
// window spend (SV-D2): no line, no dot; its row keeps its total. Nothing is
// kept between models and nothing is persisted. An agent whose provider
// reports no cost is never a line (SV-D5): it is named apart.
//
// A row's meter is read back through its buckets once per row object, so a
// model that moved nothing keeps every meter (MV-D21, M64); only the head
// moves with the clock (`lineAt`).

const MINUTE = 60_000;
/** The burn the view prints: the last five minutes, steadier than the swarm's one (SV-D7). */
export const RATE_WINDOW_MS = 5 * MINUTE;

/**
 * The meter a row reports: its cost's total, the backend's account of the
 * run. A row with no price reports nothing, never $0.
 */
export function spendOf(agent: AgentView): { usd: number; partial: boolean } | undefined {
  const cost = agent.cost;
  if (cost === undefined || cost.coverage === 'unavailable') return undefined;
  if (!Number.isFinite(cost.usd) || cost.usd < 0) return undefined;
  return { usd: cost.usd, partial: cost.coverage === 'partial' };
}

/** The meter at a moment. */
export interface SpendPoint {
  readonly t: number;
  readonly v: number;
}

/** What one priced row's meter read at each of its buckets' starts: the row's own facts, with no clock in them. */
export interface SpendMeter {
  readonly id: string;
  readonly agent: AgentView;
  /** When the run was born (`createdAt`). */
  readonly bornMs: number;
  /** The meter at each bucket's start since its birth, oldest first and never falling, up to the total. */
  readonly points: readonly SpendPoint[];
  /** Drawn from Core's buckets. False for another desktop's row, or a row with a total alone. */
  readonly recorded: boolean;
  /** Some of it went unpriced: the figure is a floor (`+`). */
  readonly partial: boolean;
  /** The meter now: the run's total, the money its row prints. */
  readonly total: number;
}

export interface SpendLine extends SpendMeter {
  /** The meter, oldest first and never falling; the last point is the head: now, at the total. */
  readonly points: readonly SpendPoint[];
}

/** An agent no price reaches: named in the list's foot, never drawn (SV-D5). */
export interface SpendUnpriced {
  readonly id: string;
  readonly agent: AgentView;
  readonly bornMs: number;
}

/** Every priced row's meter and every agent named apart, for one model: the same objects while nothing moved. */
export interface SpendMeters {
  readonly lines: readonly SpendMeter[];
  readonly unpriced: readonly SpendUnpriced[];
}

export interface SpendSet {
  readonly lines: readonly SpendLine[];
  readonly unpriced: readonly SpendUnpriced[];
}

/** Under a billionth of a dollar is the buckets' sum rounding, not money. */
const EPSILON_USD = 1e-9;

/** Readings that never fall and end at the head: a correction that lowered the meter reads flat, and the head stays the total. */
function settled(points: SpendPoint[]): SpendPoint[] {
  let low = Infinity;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]!;
    low = Math.min(low, point.v);
    if (low < EPSILON_USD) low = 0;
    if (point.v !== low) points[index] = { t: point.t, v: low };
  }
  return points;
}

/** A row's meter back through its buckets, or undefined when it has no price at all. */
export function meterOf(agent: AgentView): SpendMeter | undefined {
  const meter = spendOf(agent);
  if (!meter) return undefined;
  const bornMs = agent.createdAt;
  // Another desktop's row is a total alone (SV-D2): a peer has no line, whatever its cut carries.
  const series = agent.device.self ? agent.cost?.series : undefined;
  const steps = series !== undefined && series.stepMs > 0 ? series.steps : [];
  const base = { id: agent.id, agent, bornMs, partial: meter.partial, total: meter.usd };
  if (series === undefined || steps.length === 0) return { ...base, points: [], recorded: false };
  const first = series.lastStepAt - (steps.length - 1) * series.stepMs;
  // Back from the head, the total: the meter at a bucket's start is what it read at the next one, less the bucket.
  const points: SpendPoint[] = [{ t: Number.POSITIVE_INFINITY, v: meter.usd }];
  let v = meter.usd;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const t = first + index * series.stepMs;
    const cost = steps[index]!;
    v -= Number.isFinite(cost) ? cost : 0;
    if (t <= bornMs) {
      // The bucket it was born in: the line begins at its birth, at what the meter read then ($0 for a new run).
      points.push({ t: bornMs, v });
      break;
    }
    points.push({ t, v });
  }
  // The head at the end, so the readings settle under the total; it is dropped, and put back at now (`lineAt`).
  return { ...base, points: settled(points.reverse()).slice(0, -1), recorded: true };
}

/** One row's meter, kept while the row object is: the model keeps an unchanged row's object (MV-D21). */
const meters = new WeakMap<AgentView, SpendMeter | null>();

function cachedMeter(agent: AgentView): SpendMeter | undefined {
  let meter = meters.get(agent);
  if (meter === undefined) {
    meter = meterOf(agent) ?? null;
    meters.set(agent, meter);
  }
  return meter ?? undefined;
}

/** Every meter the view can draw, and every agent it names apart. Terminals cost nothing: they are not here. */
export function spendMeters(agents: readonly AgentView[]): SpendMeters {
  const lines: SpendMeter[] = [];
  const unpriced: SpendUnpriced[] = [];
  for (const agent of agents) {
    if (agent.kind !== 'agent') continue;
    const meter = cachedMeter(agent);
    if (meter) lines.push(meter);
    else unpriced.push({ id: agent.id, agent, bornMs: agent.createdAt });
  }
  return { lines, unpriced };
}

/** A meter as the chart reads it at `nowMs`: its points up to now, and its head there, at the total. */
export function lineAt(meter: SpendMeter, nowMs: number): SpendLine {
  const head: SpendPoint = { t: nowMs, v: meter.total };
  const bornMs = Math.min(meter.bornMs, nowMs);
  // A birth the clock has not reached yet (another clock's) begins at now, as nothing can be older than it.
  const points =
    meter.bornMs > nowMs
      ? meter.points.map((point) => (point.t > nowMs ? { t: nowMs, v: point.v } : point))
      : meter.points;
  return { ...meter, bornMs, points: [...points, head] };
}

/** One live agent's line at `nowMs`, or undefined when it has no price at all. */
export function lineOf(agent: AgentView, nowMs: number): SpendLine | undefined {
  const meter = meterOf(agent);
  return meter && lineAt(meter, nowMs);
}

/** The meters at `nowMs`: every line the view can draw, and every agent it names apart. */
export function spendAt(set: SpendMeters, nowMs: number): SpendSet {
  return { lines: set.lines.map((meter) => lineAt(meter, nowMs)), unpriced: set.unpriced };
}

/** Every line the view can draw at `nowMs`, and every agent it names apart. */
export function spendSet(agents: readonly AgentView[], nowMs: number): SpendSet {
  return spendAt(spendMeters(agents), nowMs);
}

/**
 * The meter at `t`: undefined before the line's first point — before the
 * agent was born, or for a row with a total alone, any moment but now (nobody
 * recorded it). Between two points the line's own straight piece; from the
 * head on, the total.
 */
export function valueAt(line: SpendLine, t: number): number | undefined {
  const points = line.points;
  if (t < points[0]!.t) return undefined;
  const head = points[points.length - 1]!;
  if (t >= head.t) return head.v;
  let low = 0;
  let high = points.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (points[middle]!.t <= t) low = middle;
    else high = middle;
  }
  const a = points[low]!;
  const b = points[high]!;
  if (b.t === a.t) return b.v;
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

/**
 * Estimated USD a minute over the five minutes up to `t` (SV-D7) — over as
 * much of them as the line reaches, so a run born three minutes ago burns at
 * its own pace — or undefined with under a minute to measure.
 */
export function rateAt(line: SpendLine, t: number): number | undefined {
  const now = valueAt(line, t);
  if (now === undefined) return undefined;
  const from = Math.max(t - RATE_WINDOW_MS, line.points[0]!.t);
  if (t - from < MINUTE) return undefined;
  const then = valueAt(line, from) ?? now;
  return Math.max(0, now - then) / ((t - from) / MINUTE);
}

/**
 * The line inside [ta, tb]: its points there, cut at the window's edges by its
 * own straight pieces. Fewer than two points — a head alone — is no line.
 */
export function windowPoints(line: SpendLine, ta: number, tb: number): SpendPoint[] {
  const start = Math.max(ta, line.points[0]!.t);
  const end = Math.min(tb, line.points[line.points.length - 1]!.t);
  if (end <= start) return [];
  const out: SpendPoint[] = [{ t: start, v: valueAt(line, start)! }];
  for (const point of line.points) if (point.t > start && point.t < end) out.push(point);
  out.push({ t: end, v: valueAt(line, end)! });
  return out;
}

/**
 * What the line had spent in the window by `t`: its meter less what it read
 * where the window begins for it — the window's start, or its birth for a run
 * born inside it (a resumed conversation's carried total is not window spend)
 * — so every line starts at $0. Undefined before then, and for a row with a
 * total alone, whose window spend nobody knows.
 */
export function spentAt(line: SpendLine, ta: number, t: number): number | undefined {
  if (!line.recorded) return undefined;
  const value = valueAt(line, t);
  const base = valueAt(line, Math.max(ta, line.points[0]!.t));
  return value === undefined || base === undefined ? undefined : Math.max(0, value - base);
}

/** The line as the chart draws it: its window spend across [ta, tb], from $0 to its head at now. Nothing for a row with a total alone. */
export function spentPoints(line: SpendLine, ta: number, tb: number): SpendPoint[] {
  if (!line.recorded) return [];
  const points = windowPoints(line, ta, tb);
  const base = points[0]?.v ?? 0;
  return points.map((point) => ({ t: point.t, v: Math.max(0, point.v - base) }));
}
