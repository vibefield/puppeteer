import { useMemo, useRef } from 'react';
import type {
  AgentView,
  MonitorCapabilities,
  MonitorEndedRow,
  MonitorHistory,
  MonitorLivePast,
  MonitorModel,
  MonitorPastSpan,
  MonitorView,
  ProjectTint,
} from '@vibefield/puppeteer-view-sdk';
import { lendHistory, viewWantsHistory } from '@vibefield/puppeteer-view-sdk/host';
import { projectColourFor } from '@vibefield/puppeteer-view-sdk/toolkit';

// THE PERF HARNESS'S HISTORY (TLV). Godview has no record of its own, so it lends a view no history (MV-D4; the v2
// shapes, item 9). The paired harness (`perf/harness.mjs --history-ended <n>`) sets `window.__gvPerfHistory` before
// any script runs; Godview then lends a fixture to a mounted view that declares the capability, so the timeline's cost
// with the record's past is measured on the real app beside its cost without. Unset, nothing here runs but one read.
//
// The fixture is the brief's heavy case: each agent row a day of turns before its `statusSince` (a resumed session's
// record), and `ended` runs that each ended within the hour, so all of them stand on the board at the default span,
// each with up to a day of turns. Seeded by birth order, not by id, so every launch lends the same shape. Built once
// per set of agent rows and kept as the same object between, as a host keeps a snapshot until a row leaves.

declare global {
  interface Window {
    /** Set by the perf harness alone: lend the timeline a fixture history with this many ended runs. */
    __gvPerfHistory?: { readonly ended: number } | undefined;
  }
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** The harness's agents are the imposter; so are its fixture's ended runs. */
const PROVIDER = { id: 'imposter', label: 'Imposter' };

/** A small seeded generator (mulberry32): the same seed, the same sequence. */
function seeded(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turns from `from` up to `to`: worked 5–25 min, quiet 3–20, one silence in eight drawn unrecorded. */
function turns(random: () => number, from: number, to: number): MonitorPastSpan[] {
  const spans: MonitorPastSpan[] = [];
  let t = from;
  let working = true;
  while (t < to) {
    const length = Math.min(to - t, Math.round((working ? 5 + random() * 20 : 3 + random() * 17) * MIN));
    const kind = working ? 'worked' : random() < 0.125 ? 'unrecorded' : 'quiet';
    spans.push({ kind, from: t, to: t + length });
    t += length;
    working = !working;
  }
  return spans;
}

/** The fixture for these rows at `nowMs`, coloured and receded as a host lends it. */
export function perfHistory(
  rows: readonly AgentView[],
  nowMs: number,
  ended: number,
  palette: { readonly tint: ProjectTint; readonly neutral: string },
): MonitorHistory {
  const agents = rows.filter((row) => row.kind === 'agent').sort((a, b) => a.createdAt - b.createdAt);
  const live: MonitorLivePast[] = agents.map((row, index) => ({
    id: row.id,
    seamAt: row.statusSince,
    spans: turns(seeded(index + 1), nowMs - DAY, row.statusSince),
  }));
  const runs: MonitorEndedRow[] = [];
  for (let index = 0; index < ended; index += 1) {
    const random = seeded(1000 + index);
    const endedAt = nowMs - Math.round((2 + random() * 55) * MIN);
    const startedAt = Math.max(nowMs - DAY, endedAt - Math.round((60 + random() * 22 * 60) * MIN));
    runs.push({
      id: `past:${PROVIDER.id}:perf-${index}`,
      provider: PROVIDER,
      project: { name: `project-${index % 6}`, seq: index % 6 },
      device: { id: 'perf', name: 'perf', self: true },
      startedAt,
      endedAt,
      spans: turns(random, startedAt, endedAt),
    });
  }
  runs.sort((a, b) => a.startedAt - b.startedAt);
  return lendHistory(
    { sinceMs: nowMs - DAY, untilMs: nowMs, readAt: nowMs, fidelity: 'turns', state: 'complete', live, ended: runs },
    { colourFor: projectColourFor(palette), receded: () => false },
  );
}

/**
 * The capabilities Godview lends the mounted view: the harness's fixture history when it asked and the view declares
 * the capability, else none. The same object while the agent rows and the theme are the same.
 */
export function usePerfHistory(
  model: MonitorModel,
  view: MonitorView | undefined,
  palette: { readonly tint: ProjectTint; readonly neutral: string },
): MonitorCapabilities | undefined {
  const built = useRef<{ key: string; history: MonitorHistory } | undefined>(undefined);
  const ask = window.__gvPerfHistory;
  let history: MonitorHistory | undefined;
  if (ask !== undefined && view !== undefined && viewWantsHistory(view)) {
    const ids = model.agents.filter((row) => row.kind === 'agent').map((row) => row.id);
    const key = `${palette.tint.l}:${palette.tint.c}:${palette.neutral}|${ask.ended}|${ids.join(',')}`;
    if (built.current?.key !== key) {
      built.current = { key, history: perfHistory(model.agents, Date.now(), ask.ended, palette) };
    }
    history = built.current.history;
  }
  return useMemo(() => (history === undefined ? undefined : { history }), [history]);
}
