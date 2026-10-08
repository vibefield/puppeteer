import type { AgentStatus } from '@vibecook/puppeteer-view-sdk/model';

/**
 * Which agents finished something the user has not looked at — the window's former `views/monitor/unread.ts`,
 * verbatim (the window's copy was deleted at MV-8b: this is the one ledger, L5).
 *
 * An agent is unread while it is idle, it is not in front of the user, and
 * Core says its idle began after the user last had it in front of them. "Last
 * had it in front of them" is the later of first sight and the last fold in
 * which it was active. Reading Core's `statusSince` rather than watching the
 * status change here is what keeps the rule honest under coalescing: a short
 * turn can begin and end between two folds, and a transition nobody saw would
 * otherwise never be marked. Terminals without an agent are never unread; a
 * shell finishing a command is not a reply.
 *
 * In the backend (L5) "in front of the user" is "some screen reports it shown":
 * the backend folds the union of every screen's report into `active`, so one
 * screen reporting its active pane is exactly the single-window rule.
 */
export interface UnreadLedger {
  /** When each agent was last in front of the user, epoch ms. */
  readonly seenAtById: ReadonlyMap<string, number>;
  readonly unreadIds: ReadonlySet<string>;
}

export const EMPTY_UNREAD_LEDGER: UnreadLedger = { seenAtById: new Map(), unreadIds: new Set() };

export interface UnreadCandidate {
  id: string;
  status: AgentStatus;
  active: boolean;
  /** Whether an agent is behind this row; a bare terminal never earns the dot. */
  hasAgent: boolean;
  /** Core's `statusSince`, epoch ms; absent for a terminal. */
  statusSinceMs?: number | undefined;
}

export function reconcileUnread(
  previous: UnreadLedger,
  agents: readonly UnreadCandidate[],
  nowMs: number,
): UnreadLedger {
  const seenAtById = new Map<string, number>();
  const unreadIds = new Set<string>();
  for (const agent of agents) {
    const before = previous.seenAtById.get(agent.id);
    if (agent.active || before === undefined) {
      seenAtById.set(agent.id, nowMs);
      continue;
    }
    seenAtById.set(agent.id, before);
    if (!agent.hasAgent || agent.status !== 'idle' || agent.statusSinceMs === undefined) continue;
    if (agent.statusSinceMs > before) unreadIds.add(agent.id);
  }
  return { seenAtById, unreadIds };
}
