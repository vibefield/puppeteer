import { describe, expect, it } from 'vitest';
import type { AgentView, EndedLaneView } from '@vibefield/puppeteer-view-sdk';
import { formatClock } from '@vibefield/puppeteer-view-sdk/toolkit';
import { agentViewFixture, type AgentViewFixturePartial } from '@vibefield/puppeteer-view-sdk/testing';
import { historyLanes, laneFor, stateAt, type TimelineLane } from './timeline-lanes.js';
import { BOUNDS_WORDS, endedName, laneLabel, laneName, laneSubLine, readoutAt, recordState } from './timeline-words.js';

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

describe('words for the record', () => {
  const recorded = laneFor(
    agentViewFixture({ id: 'a', createdAt: NOW - 90 * MIN, status: 'working', statusSince: NOW - 10 * MIN }),
    NOW,
    [
      { kind: 'worked', from: NOW - 80 * MIN, to: NOW - 39 * MIN },
      { kind: 'quiet', from: NOW - 39 * MIN, to: NOW - 30 * MIN },
      { kind: 'unrecorded', from: NOW - 30 * MIN, to: NOW - 20 * MIN },
      { kind: 'bounds', from: NOW - 20 * MIN, to: NOW - 10 * MIN },
    ],
  );
  const said = (ago: number) => readoutAt(recorded, stateAt(recorded, NOW - ago), NOW - ago, false, NOW);

  it('reads a worked moment as a working span reads, quiet as quiet, inside the bounds alone the detail unknown', () => {
    expect(said(42 * MIN)).toEqual({
      tone: 'working',
      big: '38:00',
      small: 'working · of 41m',
      owed: false,
      recorded: true,
    });
    expect(said(35 * MIN)).toEqual({ tone: 'idle', big: '', small: 'quiet', owed: false, recorded: true });
    expect(said(25 * MIN)).toEqual({ tone: 'unrecorded', big: '–', small: 'not recorded', owed: false });
    // The same shape as not recorded: it was active then, what it did is not in the record.
    expect(said(15 * MIN)).toEqual({ tone: 'bounds', big: '–', small: BOUNDS_WORDS, owed: false, recorded: true });
    expect(BOUNDS_WORDS).toBe('detail not recorded');
    // Never blocked and never unseen: the record holds neither, so nothing it says rings.
    expect([42, 35, 25, 15].some((minutes) => said(minutes * MIN).owed)).toBe(false);
  });

  const run = (overrides: Partial<EndedLaneView> = {}): TimelineLane =>
    historyLanes({
      sinceMs: NOW - 24 * 60 * MIN,
      untilMs: NOW,
      readAt: NOW,
      fidelity: 'turns',
      state: 'complete',
      live: [],
      ended: [
        {
          id: 'past:claude:x',
          provider: { id: 'claude', label: 'Claude Code' },
          project: { name: 'rosetta', seq: 2, branch: 'main' },
          device: { id: 'here', name: 'here', self: true },
          startedAt: NOW - 60 * MIN,
          endedAt: NOW - 3 * MIN,
          spans: [{ kind: 'worked', from: NOW - 60 * MIN, to: NOW - 3 * MIN }],
          colour: 'teal',
          receded: false,
          ...overrides,
        },
      ],
    }).ended[0]!;

  it("says an ended run's last activity: how long ago following now, the clock looking back", () => {
    const ended = run();
    // The faint lane and its end tick already say it ended: the words say when it was last active.
    expect(readoutAt(ended, stateAt(ended, NOW), NOW, true, NOW)).toEqual({
      tone: 'ended',
      big: '',
      small: 'last active 3m ago',
      owed: false,
      recorded: true,
    });
    expect(readoutAt(ended, stateAt(ended, NOW - MIN), NOW - MIN, false, NOW).small).toBe(
      `last active ${formatClock(NOW - 3 * MIN)}`,
    );
    // Inside its life it reads its record, as a row\'s past does.
    expect(readoutAt(ended, stateAt(ended, NOW - 30 * MIN), NOW - 30 * MIN, false, NOW).small).toBe('working · of 57m');
  });

  it('names an ended run by its title, else what ran it and where; its line, and its label', () => {
    const plain = run();
    expect(laneName(plain)).toBe('Claude Code · rosetta');
    expect(laneSubLine(plain)).toBe('main');
    expect(laneLabel(plain, NOW)).toBe('rosetta, Claude Code, ended, last active 3 minutes ago');
    const titled = run({ title: 'Split the invoice writer', device: { id: 'p', name: 'tower', self: false } });
    expect(laneName(titled)).toBe('Split the invoice writer');
    expect(laneSubLine(titled)).toBe('Claude Code · main');
    expect(laneLabel(titled, NOW)).toBe(
      'on tower, Split the invoice writer, rosetta, Claude Code, ended, last active 3 minutes ago',
    );
    expect(endedName({ provider: undefined, project: { name: 'notes' } })).toBe('notes');
    // A row is named as before.
    expect(laneName(lane())).toBe('notes');
  });
});

describe('recordState', () => {
  it("says a record that is not whole in SINCE's words, for a head too narrow for the sentence; a whole one says nothing", () => {
    expect(recordState('partial')).toBe('RECORD PARTIAL');
    expect(recordState('unavailable')).toBe('NO RECORD NOW');
    expect(recordState('complete')).toBe('');
  });
});
