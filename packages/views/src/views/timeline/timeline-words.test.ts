import { describe, expect, it } from 'vitest';
import type { AgentView } from '@vibecook/puppeteer-view-sdk';
import { agentViewFixture, type AgentViewFixturePartial } from '@vibecook/puppeteer-view-sdk/testing';
import { laneFor, stateAt, type TimelineLane } from './timeline-lanes.js';
import { laneLabel, laneSubLine, readoutAt } from './timeline-words.js';

const SEC = 1000;
const MIN = 60 * SEC;
const NOW = 1_000_000 * MIN;

/** A lane born an hour ago, blocked on a permission for the last five minutes, unless told otherwise. */
function lane(overrides: AgentViewFixturePartial = {}): TimelineLane {
  const row: AgentView = agentViewFixture({
    id: 'a',
    createdAt: NOW - 60 * MIN,
    status: 'blocked',
    statusSince: NOW - 5 * MIN,
    wait: { kind: 'permission', since: NOW - 5 * MIN },
    project: { name: 'notes', seq: 1 },
    ...overrides,
  });
  return laneFor(row, NOW);
}

describe('readoutAt', () => {
  it('following now: the current state’s length and word, and a wait you owe rings', () => {
    const subject = lane();
    expect(readoutAt(subject, stateAt(subject, NOW), NOW, true, NOW)).toEqual({
      tone: 'blocked',
      big: '5:00',
      small: 'blocked · permission',
      owed: true,
    });
  });

  it('looking back into the current state: how far in, and that it has lasted until now', () => {
    const subject = lane();
    const at = NOW - 2 * MIN;
    expect(readoutAt(subject, stateAt(subject, at), at, false, NOW)).toEqual({
      tone: 'blocked',
      big: '3:00',
      small: 'blocked · permission · of 5m+',
      owed: false,
    });
  });

  it('before the current state it claims nothing, and before the birth it was not started', () => {
    const subject = lane();
    expect(readoutAt(subject, stateAt(subject, NOW - 50 * MIN), NOW - 50 * MIN, false, NOW)).toEqual({
      tone: 'unrecorded',
      big: '–',
      small: 'not recorded',
      owed: false,
    });
    expect(readoutAt(subject, stateAt(subject, NOW - 70 * MIN), NOW - 70 * MIN, false, NOW)).toEqual({
      tone: 'none',
      big: '',
      small: 'not started yet',
      owed: false,
    });
  });

  it('says a reply not yet opened as unseen, owed; days from a day (M14)', () => {
    const unseen = lane({ status: 'idle', unread: true, wait: undefined, statusSince: NOW - 38 * MIN });
    expect(readoutAt(unseen, stateAt(unseen, NOW), NOW, true, NOW)).toMatchObject({
      tone: 'unseen',
      big: '38:00',
      small: 'reply unseen',
      owed: true,
    });
    const long = lane({
      status: 'working',
      wait: undefined,
      createdAt: NOW - 30 * 60 * MIN,
      statusSince: NOW - 26 * 60 * MIN,
    });
    // A stretch older than the horizon reads from it: a day, at most (as the lane is clipped).
    expect(readoutAt(long, stateAt(long, NOW), NOW, true, NOW).big).toBe('1d 00h');
    const day = lane({
      status: 'working',
      wait: undefined,
      createdAt: NOW - 30 * 60 * MIN,
      statusSince: NOW - 1450 * MIN,
    });
    expect(readoutAt(day, stateAt(day, NOW), NOW, true, NOW).big).toBe('1d 00h');
    const hours = lane({
      status: 'working',
      wait: undefined,
      createdAt: NOW - 30 * 60 * MIN,
      statusSince: NOW - 1430 * MIN,
    });
    expect(readoutAt(hours, stateAt(hours, NOW), NOW, true, NOW).big).toBe('23h 50m');
  });

  it('says a wait the toolkit does not know as itself, and a wait with no kind as a failure', () => {
    const odd = lane({ wait: { kind: 'sandbox', since: NOW } });
    expect(readoutAt(odd, stateAt(odd, NOW), NOW, true, NOW).small).toBe('blocked · sandbox');
    const bare = lane({ wait: undefined });
    expect(readoutAt(bare, stateAt(bare, NOW), NOW, true, NOW).small).toBe('blocked · failed');
  });

  it('says a terminal as running or quiet, never owed', () => {
    const shell = lane({ kind: 'terminal', status: 'idle', wait: undefined, statusSince: NOW - 31 * MIN });
    expect(readoutAt(shell, stateAt(shell, NOW), NOW, true, NOW)).toEqual({
      tone: 'idle',
      big: '',
      small: 'quiet',
      owed: false,
    });
    const busy = lane({ kind: 'terminal', status: 'working', wait: undefined, statusSince: NOW - 2 * MIN });
    expect(readoutAt(busy, stateAt(busy, NOW), NOW, true, NOW)).toEqual({
      tone: 'working',
      big: '2:00',
      small: 'running',
      owed: false,
    });
  });
});

describe('laneLabel', () => {
  it('names the lane, its peer and its present for a screen reader, with the wait’s own words', () => {
    const subject = lane({
      device: { id: 'd', name: 'studio', self: false },
      provider: { id: 'imposter', label: 'Imposter' },
      model: 'opus',
      wait: { kind: 'question', since: NOW - 5 * MIN, header: 'Grants', question: 'Expire with the session?' },
    });
    expect(laneLabel(subject, NOW)).toBe(
      'on studio, notes, opus, blocked on a question for 5 minutes: Expire with the session?',
    );
  });

  it('says what runs it as the model, else the provider, and a terminal as a terminal', () => {
    const working = lane({ status: 'working', wait: undefined, provider: { id: 'codex', label: 'Codex' } });
    expect(laneLabel(working, NOW)).toBe('notes, Codex, working for 5 minutes');
    const shell = lane({
      kind: 'terminal',
      status: 'working',
      wait: undefined,
      createdAt: NOW - 90 * MIN,
      statusSince: NOW - 61 * MIN,
    });
    expect(laneLabel(shell, NOW)).toBe('notes, terminal, running for 1 hour 1 minute');
    const quiet = lane({ kind: 'terminal', status: 'idle', wait: undefined });
    expect(laneLabel(quiet, NOW)).toBe('notes, terminal, quiet');
  });
});

describe('laneSubLine', () => {
  it('is what runs an agent and its branch, when there is any; a terminal has none', () => {
    expect(laneSubLine(lane({ model: 'opus', project: { name: 'notes', branch: 'main' } }))).toBe('opus · main');
    expect(laneSubLine(lane({ provider: { id: 'codex', label: 'Codex' }, project: { name: 'n', branch: null } }))).toBe(
      'Codex',
    );
    expect(laneSubLine(lane({ provider: undefined, model: undefined }))).toBe('');
    expect(laneSubLine(lane({ kind: 'terminal', model: 'opus' }))).toBe('');
  });
});
