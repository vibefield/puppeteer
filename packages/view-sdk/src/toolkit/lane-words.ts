import type { MonitorWait } from '../model.js';

// A TIMELINE LANE'S WAIT, IN THE LANE'S OWN ORDER (M2, M14): what a blocked
// lane says it waits on is the blocker's own detail line, else a question's
// prompt. The swarm's body words the same wait in its own order (header or
// prompt, then detail, tool, code); the two orders stay apart until a design
// event unifies them (M2).
//
// Ported from the timeline's status ledger (`status-ledger.ts`'s `blockerOf`
// and `bounded`, which MV-6 removed with the ledger), so a lane says exactly
// what it said: trimmed, nothing at all for a blank line, and cut at 160
// UTF-16 units with an ellipsis.

/** The longest a lane's wait words run, in UTF-16 units: the ledger's bound, kept so a lane reads as it did. */
export const LANE_WAIT_WORDS_MAX = 160;

/**
 * What a blocked lane waits on, in words: the wait's detail, else a question's
 * prompt, trimmed and bounded. Nothing when the wait carries no words (a
 * permission with only its tool, a cut that carries no content).
 */
export function laneWaitWords(wait: Pick<MonitorWait, 'kind' | 'detail' | 'question'> | undefined): string | undefined {
  const text = (wait?.detail ?? (wait?.kind === 'question' ? wait.question : undefined))?.trim();
  if (!text) return undefined;
  return text.length > LANE_WAIT_WORDS_MAX ? `${text.slice(0, LANE_WAIT_WORDS_MAX - 1)}…` : text;
}
