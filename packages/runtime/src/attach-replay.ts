import type { AgentAdapterBinding, AttachReplayMiss } from '@vibefield/puppeteer-core';

/** How long an attach given `replayAfter` waits for the agent's record to be read before it says it was not. */
export const ATTACH_REPLAY_BOUND_MS = 5_000;

/** What an attach given `replayAfter` says on its result. */
export interface AttachReplayOutcome {
  replayedAfter: boolean;
  replayMissed?: AttachReplayMiss;
}

/**
 * The binding's word on its replay after the host's cursor, within the bound: replayed, or why not. A binding with no
 * word replays nothing; a refusal is a record it could not read; no word in time is said as that.
 */
export async function attachReplayOutcome(
  session: Pick<AgentAdapterBinding, 'replayedAfter'>,
  boundMs: number = ATTACH_REPLAY_BOUND_MS,
): Promise<AttachReplayOutcome> {
  if (!session.replayedAfter) return { replayedAfter: false, replayMissed: 'not-replayable' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<'bound'>((resolve) => {
    timer = setTimeout(() => resolve('bound'), boundMs);
  });
  try {
    const replayed = await Promise.race([session.replayedAfter().catch(() => 'unread' as const), bound]);
    if (replayed === 'bound') return { replayedAfter: false, replayMissed: 'not-read-in-time' };
    if (replayed === 'unread') return { replayedAfter: false, replayMissed: 'record-unread' };
    return replayed ? { replayedAfter: true } : { replayedAfter: false, replayMissed: 'cursor-not-found' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
