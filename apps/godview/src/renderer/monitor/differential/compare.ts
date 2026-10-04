import { classifyMonitorRecency } from '@vibecook/puppeteer-core';
import type { MonitorAgent as ViewsMonitorAgent } from '@vibecook/puppeteer-views';
import { viewReadProjection, type MonitorAgentViewReads } from '@vibecook/puppeteer-views/legacy';
import type { MonitorAgent } from '../types.js';
import type { FrameRows } from './harness.js';

/**
 * The comparison: each side's rows through `viewReadProjection` (exactly what
 * the four views and the status ledger read), paired by identity (`id`,
 * `visualId` — how each side NAMES a row, not a fact), then field by field. The
 * cost rate is compared with a float tolerance: the backend carries it per hour
 * and the shim divides it back.
 */

export interface RowDifference {
  readonly at: number;
  readonly id: string;
  /** The read's path, e.g. `agent.monitor.usage.costRatePerMin`. */
  readonly path: string;
  readonly old: unknown;
  readonly next: unknown;
}

export interface FrameComparison {
  readonly at: number;
  readonly onlyOld: readonly string[];
  readonly onlyNew: readonly string[];
  readonly differences: readonly RowDifference[];
}

const FLOAT_PATHS = new Set(['agent.monitor.usage.costRatePerMin']);

function keyOf(read: MonitorAgentViewReads): string {
  return `${read.id}\u0000${read.visualId}`;
}

function walk(
  path: string,
  old: unknown,
  next: unknown,
  report: (path: string, old: unknown, next: unknown) => void,
): void {
  if (FLOAT_PATHS.has(path) && typeof old === 'number' && typeof next === 'number') {
    if (Math.abs(old - next) > 1e-9 * Math.max(1, Math.abs(old))) report(path, old, next);
    return;
  }
  const oldObject = typeof old === 'object' && old !== null;
  const nextObject = typeof next === 'object' && next !== null;
  if (oldObject && nextObject && Array.isArray(old) === Array.isArray(next)) {
    const keys = new Set([...Object.keys(old as object), ...Object.keys(next as object)]);
    for (const key of keys) {
      walk(
        path ? `${path}.${key}` : key,
        (old as Record<string, unknown>)[key],
        (next as Record<string, unknown>)[key],
        report,
      );
    }
    return;
  }
  if (JSON.stringify(old) !== JSON.stringify(next)) report(path, old, next);
}

export function compareFrame(frame: FrameRows): FrameComparison {
  const oldReads = new Map(
    frame.old.map((agent) => {
      const read = viewReadProjection(agent as unknown as ViewsMonitorAgent);
      return [keyOf(read), read] as const;
    }),
  );
  const nextReads = new Map(
    frame.next.map((agent) => {
      const read = viewReadProjection(agent);
      return [keyOf(read), read] as const;
    }),
  );
  const differences: RowDifference[] = [];
  for (const [key, old] of oldReads) {
    const next = nextReads.get(key);
    if (!next) continue;
    const { id: _oldId, visualId: _oldVisual, ...oldRest } = old;
    const { id: _nextId, visualId: _nextVisual, ...nextRest } = next;
    walk('', oldRest, nextRest, (path, oldValue, nextValue) =>
      differences.push({ at: frame.at, id: old.id, path, old: oldValue, next: nextValue }),
    );
  }
  return {
    at: frame.at,
    onlyOld: [...oldReads.keys()].filter((key) => !nextReads.has(key)).map((key) => key.replace('\u0000', ' | ')),
    onlyNew: [...nextReads.keys()].filter((key) => !oldReads.has(key)).map((key) => key.replace('\u0000', ' | ')),
    differences,
  };
}

/** Why a difference is expected; undefined: unexplained, and the gate fails. */
export type DifferenceCause = (difference: RowDifference, frame: FrameRows) => string | undefined;

function oldRow(frame: FrameRows, id: string): MonitorAgent | undefined {
  return frame.old.find((agent) => agent.id === id);
}

export const KNOWN_CAUSES: Readonly<Record<string, DifferenceCause>> = {
  /**
   * Recency: the old seam judged staleness against a React clock that moved
   * only every 10 s from the window's mount; the backend reads its clock at
   * every recompute (and on its own 10 s clock), so a row crossing the 30 s
   * threshold between two ticks flips up to 10 s earlier when anything else
   * moves. Only a difference the two clocks explain is accepted.
   */
  "recency read at the change, not on the window's 10 s clock": (difference, frame) => {
    if (difference.path !== 'stale') return undefined;
    const evidence = oldRow(frame, difference.id)?.agent?.monitor.freshness.lastEvidenceAt;
    const atChange = classifyMonitorRecency(evidence, frame.at).recency === 'stale';
    const atTick = classifyMonitorRecency(evidence, frame.oldNowMs).recency === 'stale';
    return atChange !== atTick && difference.old === atTick && difference.next === atChange ? 'yes' : undefined;
  },
  /**
   * The backend names every agent's profile set (`native` when the host names
   * none: VibeField's `agentProfileSet`); Godview's seam named none. Godview's
   * views read it only on a TERMINAL's line (`AgentSwarm`: agents excluded) and
   * under the spawn bloom and the list's spawn menu, which Godview does not
   * mount (it passes no `spawnMenu`), so nothing draws it.
   */
  "the backend names an agent's profile set; Godview draws it nowhere": (difference, frame) =>
    difference.path === 'profileSet' &&
    difference.old === undefined &&
    difference.next === 'native' &&
    oldRow(frame, difference.id)?.agent !== undefined
      ? 'yes'
      : undefined,
  /**
   * The backend trims a text it carries (`boundText`). Core already trims the
   * reply (reduce.ts `boundAssistantMessage`), and every view trims what it
   * draws (`latestMessage`, `blockerText`, the ledger), so only a synthesized
   * untrimmed text can differ, and never visibly.
   */
  /**
   * Nothing priced: the old seam's usage ledger kept a history for every run,
   * `{ coverage: 'unavailable' }` with no total; the backend's row carries no
   * cost, so the shim gives no `usage` (and no `costCoverage` when Core said
   * `unavailable`). The swarm reads `usage.total` (undefined both ways: "—") and
   * prices only `complete`/`partial`, so it draws the same.
   */
  'nothing priced: coverage "unavailable" or absent, drawn as "—" either way': (difference) => {
    const unpriced =
      (difference.path === 'agent.usage' && JSON.stringify(difference.old) === '{"coverage":"unavailable"}') ||
      (difference.path === 'agent.monitor.usage' &&
        JSON.stringify(difference.old) === '{"costCoverage":"unavailable"}') ||
      (difference.path === 'agent.monitor.usage.costCoverage' && difference.old === 'unavailable');
    return unpriced && difference.next === undefined ? 'yes' : undefined;
  },
  /**
   * The same-frame unread race: the turn ended in the very frame the person
   * moved their active pane. The old seam folded both in one render; the backend
   * read the end while the window still showed the row (its shown report comes
   * after). Either outcome happened in the old seam too, depending on which
   * landed first; accepted only for a row whose state arrived in a frame that
   * moved the active pane.
   */
  'the same-frame unread race: the turn ended as the active pane moved': (difference, frame) => {
    if (difference.path !== 'unread' || !frame.activeChanged) return undefined;
    const run = oldRow(frame, difference.id)?.agent?.info.runtimeRunId;
    return run !== undefined && frame.statesFor.has(run) ? 'yes' : undefined;
  },
  /**
   * A blank activity line is no line: the backend carries none (`boundedOrAbsent`), and its only readers, the
   * timeline's lane (`did ? { did } : {}`) and the status ledger (`bounded`: blank is undefined), skip a blank one.
   */
  'a blank activity line is no line, as the timeline and the ledger read it': (difference) => {
    const blank =
      (difference.path === 'agent.monitor.activity' &&
        typeof (difference.old as { line?: unknown } | undefined)?.line === 'string' &&
        (difference.old as { line: string }).line.trim() === '') ||
      (difference.path === 'agent.monitor.activity.line' &&
        typeof difference.old === 'string' &&
        difference.old.trim() === '');
    return blank && difference.next === undefined ? 'yes' : undefined;
  },
  'the backend trims a text, as Core and every view already do': (difference) =>
    typeof difference.old === 'string' &&
    typeof difference.next === 'string' &&
    difference.old !== difference.next &&
    difference.old.trim() === difference.next
      ? 'yes'
      : undefined,
};

export function classify(
  comparison: FrameComparison,
  frame: FrameRows,
  causes: Readonly<Record<string, DifferenceCause>> = KNOWN_CAUSES,
): { explained: Map<string, number>; unexplained: RowDifference[] } {
  const explained = new Map<string, number>();
  const unexplained: RowDifference[] = [];
  for (const difference of comparison.differences) {
    const cause = Object.entries(causes).find(([, matches]) => matches(difference, frame) !== undefined)?.[0];
    if (cause) explained.set(cause, (explained.get(cause) ?? 0) + 1);
    else unexplained.push(difference);
  }
  return { explained, unexplained };
}
