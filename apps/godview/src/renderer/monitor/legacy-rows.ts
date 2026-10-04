import type { MonitorModel } from '@vibecook/puppeteer-view-sdk/model';
import type { MonitorAgent as ViewsMonitorAgent } from '@vibecook/puppeteer-views';
import { toMonitorAgents, type LegacyShimOptions } from '@vibecook/puppeteer-views/legacy';
import { sessionIdForRow, visualIdsForRows, type MonitorTerminalRecord } from './window-facts.js';

/**
 * The rows Godview's four views draw until they are ported (L9): the legacy
 * shim's rows for the replica's model, in Godview's words (`headline-cost`, M4;
 * it has no peers, so `map` changes nothing, M9), with the one window fact the
 * views read that the model has no field for: the swarm's spatial identity
 * (`visualId`), carried exactly as the seam carried it, so a launcher's agent
 * keeps the fresh shell's body and a handed-off shell the dead agent's. And
 * the seam's one rule over it: one body per visual identity — when two rows
 * would wear the same one (a launched agent's first state can arrive while the
 * fresh shell it takes over is still in its pane), the earlier row in the
 * model's order (agents first) speaks for it and the other is not drawn.
 *
 * Identity is kept (MV-D21): the same model and the same window facts give the
 * same list; a row whose visual id did not move keeps its object.
 */

export const GODVIEW_SHIM: LegacyShimOptions = Object.freeze({ detail: 'headline-cost', peerMonitor: 'map' });

/** What the legacy rows read of this window. A new object means the facts moved. */
export interface LegacyRowsFacts {
  /** Each agent row's terminal session. */
  readonly agentSessions: ReadonlyMap<string, string>;
  /** This window's terminals (merged). */
  readonly terminals: readonly MonitorTerminalRecord[];
  readonly identities: ReadonlyMap<string, string> | undefined;
  /** The visual ids this window transferred, by terminal session. */
  readonly visualIds: ReadonlyMap<string, string> | undefined;
}

export interface LegacyRows {
  rowsFor(model: MonitorModel, facts: LegacyRowsFacts): readonly ViewsMonitorAgent[];
}

const NO_ROWS: readonly ViewsMonitorAgent[] = Object.freeze([]);

function sameList<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function createLegacyRows(): LegacyRows {
  let model: MonitorModel | undefined;
  let facts: LegacyRowsFacts | undefined;
  let rows: readonly ViewsMonitorAgent[] = NO_ROWS;
  /** Every row's visual id last time: the seam's carry-forward (`previousVisualIds`). */
  let visualIds: ReadonlyMap<string, string> = new Map();
  const patched = new WeakMap<ViewsMonitorAgent, { readonly visualId: string; readonly row: ViewsMonitorAgent }>();
  return {
    rowsFor(current, windowFacts) {
      if (model === current && facts === windowFacts) return rows;
      const shim = toMonitorAgents(current, GODVIEW_SHIM);
      const next = visualIdsForRows(
        current.agents,
        (row) => sessionIdForRow(row, windowFacts.agentSessions, windowFacts.terminals, windowFacts.identities),
        windowFacts.visualIds,
        visualIds,
      );
      const drawn: ViewsMonitorAgent[] = [];
      const bodies = new Set<string>();
      for (const row of shim) {
        const visualId = next.get(row.id) ?? row.id;
        if (bodies.has(visualId)) continue;
        bodies.add(visualId);
        if (visualId === row.id) {
          drawn.push(row);
          continue;
        }
        const held = patched.get(row);
        if (held?.visualId === visualId) {
          drawn.push(held.row);
          continue;
        }
        const made = Object.freeze({ ...row, visualId });
        patched.set(row, { visualId, row: made });
        drawn.push(made);
      }
      // The same list while every row is the same object: every view caches on identity.
      rows = sameList(drawn, shim) ? shim : sameList(drawn, rows) ? rows : Object.freeze(drawn);
      model = current;
      facts = windowFacts;
      // The seam carried forward only the rows it drew.
      visualIds = new Map(drawn.map((row) => [row.id, row.visualId ?? row.id] as const));
      return rows;
    },
  };
}
