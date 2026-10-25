import { describe, expect, it } from 'vitest';
import { AppServerError, AppServerRequestTimeoutError } from '../transport/app-server-client.js';
import { refusesPaginatedHistory, turnsOf } from './thread-history.js';

describe('refusesPaginatedHistory', () => {
  it('recognizes the experimental gate exactly as 0.150.0 answers it', () => {
    // The 0.150.0 pagination probe's answers (critic: the gate is gone at rust-v0.151.0).
    for (const message of [
      'thread/resume.excludeTurns requires experimentalApi capability',
      'thread/turns/list requires experimentalApi capability',
    ]) {
      expect(refusesPaginatedHistory(new AppServerError({ code: -32600, message })), message).toBe(true);
    }
  });

  it('recognizes a server that does not know the method', () => {
    const unknown = 'Invalid request: unknown variant `thread/turns/list`, expected one of `initialize`, …';
    expect(refusesPaginatedHistory(new AppServerError({ code: -32600, message: unknown }))).toBe(true);
    expect(refusesPaginatedHistory(new AppServerError({ code: -32601, message: 'imposter does not serve x' }))).toBe(
      true,
    );
  });

  it('leaves every other failure to the caller', () => {
    for (const error of [
      new AppServerError({ code: -1, message: 'no rollout found for thread id' }),
      new AppServerError({ code: -32600, message: 'invalid thread id: invalid character' }),
      new AppServerError({ code: -32603, message: 'requires experimentalApi capability' }),
      new AppServerRequestTimeoutError('thread/turns/list', 30_000),
      new Error('app-server transport closed'),
      'requires experimentalApi capability',
    ]) {
      expect(refusesPaginatedHistory(error), String(error)).toBe(false);
    }
  });
});

describe('turnsOf', () => {
  it("reads a resume's initial page first, then thread.turns, and nothing from an excluded resume", () => {
    expect(turnsOf({ initialTurnsPage: { data: [{ id: 'paged' }] }, thread: { turns: [{ id: 'full' }] } })).toEqual([
      { id: 'paged' },
    ]);
    expect(turnsOf({ initialTurnsPage: { data: [] }, thread: { turns: [{ id: 'full' }] } })).toEqual([{ id: 'full' }]);
    expect(turnsOf({ thread: { id: 'th', turns: [] } })).toEqual([]);
    expect(turnsOf(undefined)).toEqual([]);
  });
});
