import { describe, expect, it } from 'vitest';
import { ATTACH_REPLAY_BOUND_MS, attachReplayOutcome } from './attach-replay.js';

describe('attachReplayOutcome', () => {
  it('says the binding replayed after the cursor, or found no cursor', async () => {
    expect(await attachReplayOutcome({ replayedAfter: async () => true })).toEqual({ replayedAfter: true });
    expect(await attachReplayOutcome({ replayedAfter: async () => false })).toEqual({
      replayedAfter: false,
      replayMissed: 'cursor-not-found',
    });
  });

  it('says a record the binding could not read, and a binding that replays nothing', async () => {
    const unread = async () => Promise.reject(new Error('no transcript was found for the session'));
    expect(await attachReplayOutcome({ replayedAfter: unread })).toEqual({
      replayedAfter: false,
      replayMissed: 'record-unread',
    });
    expect(await attachReplayOutcome({})).toEqual({ replayedAfter: false, replayMissed: 'not-replayable' });
  });

  it('says the bound ended a read that gave no word in time', async () => {
    const never = () => new Promise<boolean>(() => undefined);
    expect(await attachReplayOutcome({ replayedAfter: never }, 10)).toEqual({
      replayedAfter: false,
      replayMissed: 'not-read-in-time',
    });
    expect(ATTACH_REPLAY_BOUND_MS).toBe(5_000);
  });
});
