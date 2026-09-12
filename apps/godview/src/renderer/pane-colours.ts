import { paneTint, type ProjectTint } from './project-tint.js';

/**
 * Each pane owns a colour (record §02, revised 2026-09-12): dealt in the
 * order panes are opened, on the pane wheel that runs parallel to the
 * project wheel, and never dealt twice while the window lives, so a closed
 * pane's colour does not reappear on its neighbour. The session shown in a
 * pane wears the pane's colour while it is mounted there: the band and, when
 * the pane is the selected one, the light beyond it. The project's colour is
 * the session's own mark and travels with it.
 */
export interface PaneColourLedger {
  readonly seqById: ReadonlyMap<string, number>;
  /** One past the highest sequence ever dealt. */
  readonly next: number;
}

export const EMPTY_PANE_COLOUR_LEDGER: PaneColourLedger = { seqById: new Map(), next: 0 };

/** Deal the panes that are new, forget the ones that closed, keep everyone else's number. */
export function dealPaneColours(previous: PaneColourLedger, paneIds: readonly string[]): PaneColourLedger {
  const seqById = new Map<string, number>();
  let next = previous.next;
  for (const paneId of paneIds) {
    const known = previous.seqById.get(paneId);
    if (known !== undefined) {
      seqById.set(paneId, known);
      continue;
    }
    seqById.set(paneId, next);
    next += 1;
  }
  // Nothing opened and nothing closed: the same ledger, so nothing downstream redraws.
  if (next === previous.next && seqById.size === previous.seqById.size) return previous;
  return { seqById, next };
}

/** Every dealt pane's colour under the theme's tint. */
export function paneColours(ledger: PaneColourLedger, tint: ProjectTint): ReadonlyMap<string, string> {
  return new Map([...ledger.seqById].map(([paneId, seq]) => [paneId, paneTint(seq, tint)] as const));
}
