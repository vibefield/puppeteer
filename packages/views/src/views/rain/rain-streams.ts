import type { AgentView } from '@vibefield/puppeteer-view-sdk';
import { modelWord, projectName } from '@vibefield/puppeteer-view-sdk/toolkit';

// The rain's column bookkeeping, ported from vibe-field's views/rain/rain-streams.ts.

export interface RainDrop {
  agentId: string;
  /** Head position in rows; fractional, so a stream can crawl slower than one row a frame. */
  y: number;
  speed: number;
}

export interface ReconcileRainColumnsInput {
  /** Agent ids in display order; earlier ids claim their preferred column first. */
  agents: readonly string[];
  columns: number;
  previous: ReadonlyMap<number, RainDrop>;
  createDrop: (agentId: string) => RainDrop;
}

/** Two adjacent streams per agent wherever the stage has room for them. */
const STREAMS_PER_AGENT = 2;

function nearestFreeColumn(taken: ReadonlyMap<number, RainDrop>, columns: number, ideal: number): number | undefined {
  for (let offset = 0; offset < columns; offset += 1) {
    const right = ideal + offset;
    if (right < columns && !taken.has(right)) return right;
    const left = ideal - offset;
    if (left >= 0 && !taken.has(left)) return left;
  }
  return undefined;
}

/**
 * Assign columns to agents, keeping the ones already placed where they are.
 *
 * The prototype rebuilt every stream from scratch on each change, which is fine
 * for a fixed cast but not here: agents arrive and leave constantly, and a
 * rebuild would re-randomize every head position, so the whole field would jump
 * whenever anyone spawned. Only new agents are placed, and only freed columns
 * are reused. When there is not room for everyone, later agents go unplaced —
 * which is visible on screen rather than silent.
 */
export function reconcileRainColumns(input: ReconcileRainColumnsInput): Map<number, RainDrop> {
  const { agents, columns, previous, createDrop } = input;
  const next = new Map<number, RainDrop>();
  if (columns <= 0 || agents.length === 0) return next;

  const spacing = columns / agents.length;
  const target = spacing >= STREAMS_PER_AGENT ? STREAMS_PER_AGENT : 1;
  const live = new Set(agents);
  const held = new Map<string, number[]>();
  for (const [column, drop] of previous) {
    if (column >= columns || !live.has(drop.agentId)) continue;
    const existing = held.get(drop.agentId) ?? [];
    // Reclaim every surplus stream before newcomers compete for free columns.
    if (existing.length >= target) continue;
    next.set(column, drop);
    held.set(drop.agentId, [...existing, column]);
  }

  for (const [index, agentId] of agents.entries()) {
    const existing = held.get(agentId) ?? [];
    if (existing.length >= target) continue;
    const ideal = Math.min(columns - 1, Math.max(0, Math.floor(index * spacing + spacing / 2)));
    for (let placed = existing.length; placed < target; placed += 1) {
      const column = nearestFreeColumn(next, columns, ideal);
      if (column === undefined) break;
      next.set(column, createDrop(agentId));
    }
  }

  return next;
}

/**
 * What a column says when you read it top to bottom. Symbols are flattened to
 * spaces so every cell holds one grid-width glyph and the stream stays a
 * column rather than a ragged edge.
 */
/**
 * THE HOST IS IN THE STREAM. A terminal on another desktop has no agent to
 * name, and without this branch it fell into the `<project> terminal` text an
 * unclaimed LOCAL terminal takes — byte-identical on the canvas. The peer's
 * name comes FIRST, so the column cannot be misread, and nothing follows its
 * project: every peer session is writable, the default and universal setting
 * (James, 2026-10-28), so the stream marks no write policy.
 */
export function rainDataString(agent: AgentView): string {
  const usedPercent = agent.kind === 'agent' ? agent.context?.usedPercent : undefined;
  const parts =
    agent.kind === 'agent'
      ? [
          projectName(agent),
          agent.project.branch,
          modelWord(agent),
          usedPercent === undefined ? undefined : `CTX:${Math.round(usedPercent).toString().padStart(2, '0')}%`,
        ]
      : !agent.device.self
        ? [agent.device.name, projectName(agent)]
        : [projectName(agent), 'terminal'];
  return ` ${parts.filter(Boolean).join(' ')} `.replace(/[^a-zA-Z0-9\s%.]/g, ' ');
}

/** Context usage sets the tail, floored so that a stream always reads as one. */
export function rainTailLength(agent: AgentView, rows: number, tailMultiplier: number, dataLength: number): number {
  const usedPercent = agent.kind === 'agent' ? agent.context?.usedPercent : undefined;
  // An unmeasured window is the common case — it only appears once the agent
  // reports one — so it sits mid-scale. Reading it as almost-nothing left a
  // working stream as a head and two fading glyphs with no lit body between.
  const usage = usedPercent === undefined ? 0.5 : Math.min(1, Math.max(0, usedPercent / 100));
  const base = Math.max(3, usage * rows * 0.9) * tailMultiplier;
  // Brightness ramps linearly across the tail, so a short one does not just cut
  // the stream short — it makes the color fall off within a few rows, leaving a
  // head and a fade where the lit body should be. Context still extends the
  // tail past the floor wherever the stage has rows to spend.
  return Math.max(base, dataLength + 6);
}
