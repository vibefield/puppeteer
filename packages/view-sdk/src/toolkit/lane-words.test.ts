import { describe, expect, it } from 'vitest';
import type { MonitorWait } from '../model.js';
import { LANE_WAIT_WORDS_MAX, laneWaitWords } from './lane-words.js';

const SINCE = Date.UTC(2026, 0, 1, 12);

describe('a timeline lane’s wait words (M2’s second order, M14)', () => {
  it('says the blocker’s own detail first, whatever the kind', () => {
    expect(laneWaitWords({ kind: 'permission', detail: 'Bash · pnpm verify' })).toBe('Bash · pnpm verify');
    expect(laneWaitWords({ kind: 'question', detail: 'the detail', question: 'Ship it?' })).toBe('the detail');
    expect(laneWaitWords({ kind: 'failure', detail: 'rate limited · retrying' })).toBe('rate limited · retrying');
  });

  it('says a question’s prompt when the blocker has no detail, and only a question’s', () => {
    expect(laneWaitWords({ kind: 'question', question: 'Keep the old export behind a flag?' })).toBe(
      'Keep the old export behind a flag?',
    );
    expect(laneWaitWords({ kind: 'permission', question: 'not a question’s' })).toBeUndefined();
  });

  it('says nothing when the wait carries no words: only its tool, a blank line, no wait at all', () => {
    expect(laneWaitWords({ kind: 'permission' })).toBeUndefined();
    expect(laneWaitWords({ kind: 'question', detail: '   ' })).toBeUndefined();
    expect(laneWaitWords(undefined)).toBeUndefined();
  });

  it('a blank detail is still the detail: it does not fall through to the prompt, as the ledger read it', () => {
    expect(laneWaitWords({ kind: 'question', detail: '', question: 'Ship it?' })).toBeUndefined();
  });

  it('trims, and cuts what runs past 160 UTF-16 units with an ellipsis, 160 in all', () => {
    expect(laneWaitWords({ kind: 'question', question: '  Merge it?  ' })).toBe('Merge it?');
    const exact = 'x'.repeat(LANE_WAIT_WORDS_MAX);
    expect(laneWaitWords({ kind: 'failure', detail: exact })).toBe(exact);
    const long = laneWaitWords({ kind: 'failure', detail: `${'y'.repeat(LANE_WAIT_WORDS_MAX)}z` });
    expect(long).toHaveLength(LANE_WAIT_WORDS_MAX);
    expect(long?.endsWith('y…')).toBe(true);
  });

  it('reads only the wait’s words: the rest of a MonitorWait changes nothing', () => {
    const wait: MonitorWait = {
      kind: 'question',
      since: SINCE,
      count: 3,
      header: 'Deploy',
      tool: 'Bash',
      question: 'Now?',
    };
    expect(laneWaitWords(wait)).toBe('Now?');
  });
});
