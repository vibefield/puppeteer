import { describe, expect, it } from 'vitest';
import type { TimelineLane } from './timeline-lanes.js';
import { stateAt } from './timeline-lanes.js';
import { blockerWord, formatElapsed, formatShort, formatWords, laneLabel, readoutAt } from './timeline-words.js';

const SEC = 1000;
const MIN = 60 * SEC;
const NOW = 1_000_000 * MIN;

describe('the formats', () => {
  it('speaks the swarm’s elapsed, the short lengths and words', () => {
    expect(formatElapsed(4 * MIN + 39 * SEC)).toBe('4:39');
    expect(formatElapsed(62 * MIN)).toBe('1h 02m');
    expect(formatElapsed(26 * 60 * MIN)).toBe('1d 02h');
    expect(formatShort(45 * SEC)).toBe('45s');
    expect(formatShort(7 * MIN)).toBe('7m');
    expect(formatShort(134 * MIN)).toBe('2h 14m');
    expect(formatShort(120 * MIN)).toBe('2h');
    expect(formatWords(20 * SEC)).toBe('under a minute');
    expect(formatWords(61 * MIN)).toBe('1 hour 1 minute');
  });

  it('says each blocker kind, and an unknown kind as itself', () => {
    expect(blockerWord('permission')).toBe('permission');
    expect(blockerWord('question')).toBe('question');
    expect(blockerWord('failure')).toBe('failed');
    expect(blockerWord('rate-limit')).toBe('rate-limit');
  });
});

function lane(overrides: Partial<TimelineLane> = {}): TimelineLane {
  return {
    id: 'a',
    agent: {
      id: 'a',
      createdAtMs: NOW - 60 * MIN,
      status: 'idle',
      project: 'notes',
      detail: '',
      color: '#123',
      active: false,
    },
    kind: 'agent',
    receded: false,
    bornMs: NOW - 60 * MIN,
    recordedFromMs: NOW - 40 * MIN,
    spans: [
      { status: 'working', fromMs: NOW - 40 * MIN, toMs: NOW - 12 * MIN },
      { status: 'idle', fromMs: NOW - 12 * MIN, toMs: NOW - 5 * MIN },
      { status: 'blocked', fromMs: NOW - 5 * MIN, blocker: { kind: 'permission' } },
    ],
    ...overrides,
  };
}

describe('readoutAt', () => {
  it('following now: the open state’s length and word, and a wait you owe rings', () => {
    const subject = lane();
    expect(readoutAt(subject, stateAt(subject, NOW), NOW, true, NOW)).toEqual({
      tone: 'blocked',
      big: '5:00',
      small: 'blocked · permission',
      owed: true,
    });
  });

  it('looking back: how far into that state it was, of how long', () => {
    const subject = lane();
    const at = NOW - 12 * MIN + 4 * MIN + 39 * SEC;
    expect(readoutAt(subject, stateAt(subject, at), at, false, NOW)).toEqual({
      tone: 'idle',
      big: '4:39',
      small: 'idle · of 7m',
      owed: false,
    });
    const atOpen = NOW - 2 * MIN;
    expect(readoutAt(subject, stateAt(subject, atOpen), atOpen, false, NOW).small).toBe(
      'blocked · permission · of 5m+',
    );
  });

  it('says ended, not recorded and not started', () => {
    const ended = lane({ endedAtMs: NOW - 3 * MIN });
    expect(readoutAt(ended, stateAt(ended, NOW), NOW, true, NOW).small).toBe('ended 3m ago');
    const subject = lane();
    expect(readoutAt(subject, stateAt(subject, NOW - 50 * MIN), NOW - 50 * MIN, false, NOW)).toMatchObject({
      tone: 'unrecorded',
      big: '–',
      small: 'not recorded',
    });
    expect(readoutAt(subject, stateAt(subject, NOW - 70 * MIN), NOW - 70 * MIN, false, NOW).small).toBe(
      'not started yet',
    );
  });

  it('says a reply not yet opened as unseen, and a terminal as running or quiet', () => {
    const unseen = lane({ spans: [{ status: 'unseen', fromMs: NOW - 38 * MIN }] });
    expect(readoutAt(unseen, stateAt(unseen, NOW), NOW, true, NOW)).toMatchObject({
      small: 'reply unseen',
      owed: true,
    });
    const shell = lane({ kind: 'terminal', spans: [{ status: 'idle', fromMs: NOW - 31 * MIN }] });
    expect(readoutAt(shell, stateAt(shell, NOW), NOW, true, NOW)).toEqual({
      tone: 'idle',
      big: '',
      small: 'quiet',
      owed: false,
    });
  });
});

describe('laneLabel', () => {
  it('names the lane, its peer and its present for a screen reader', () => {
    const subject = lane({
      agent: {
        ...lane().agent,
        remote: {
          deviceId: 'd',
          deviceName: 'studio',
          remoteSessionId: 'r',
          attachable: true,
          hostWritable: true,
          cwdLabel: null,
        },
        agent: { provider: { id: 'imposter', label: 'Imposter' }, model: 'opus', recency: 'fresh' },
      },
    });
    expect(laneLabel(subject, NOW)).toBe('on studio, notes, opus, blocked on a permission for 5 minutes');
  });
});
