import { describe, expect, it } from 'vitest';
import type { MonitorAgentRow } from '../model.js';
import {
  approachRecede,
  everyReceded,
  openingWord,
  RECEDED_EMPTY_OPACITY,
  RECEDED_OPACITY,
  recedeTarget,
  STATE_WORDS,
  stateTone,
  stateWord,
  statusWord,
  unreadSpoken,
  waitMark,
  waitWord,
} from './state-words.js';

type StateRow = Pick<MonitorAgentRow, 'kind' | 'status' | 'unread' | 'wait'>;

const agent = (row: Partial<StateRow>): StateRow => ({ kind: 'agent', status: 'idle', unread: false, ...row });

describe('the words', () => {
  it('says a status as a row says it', () => {
    expect([statusWord('idle'), statusWord('working'), statusWord('blocked')]).toEqual(['idle', 'working', 'blocked']);
  });

  it('says a wait by its kind, a new kind as itself, and none as a failure', () => {
    expect(waitWord('permission')).toBe('permission');
    expect(waitWord('question')).toBe('question');
    expect(waitWord('failure')).toBe('failed');
    expect(waitWord('sandbox')).toBe('sandbox');
    expect(waitWord(undefined)).toBe('failed');
  });

  it('asks with a known mark, and the failure mark for anything else', () => {
    expect(waitMark('permission')).toBe('permission');
    expect(waitMark('question')).toBe('question');
    expect(waitMark('sandbox')).toBe('failure');
    expect(waitMark(undefined)).toBe('failure');
  });

  it('says an opening terminal and an unread reply', () => {
    expect(openingWord()).toBe('opening');
    expect(openingWord('mini')).toBe('opening on mini');
    expect(unreadSpoken()).toBe('new message');
    expect(unreadSpoken('Done — tests pass.')).toBe('new message: Done — tests pass.');
    expect(STATE_WORDS.unread.state).toBe('reply unseen');
    expect(STATE_WORDS.kind.remote).toBe('remote session');
  });
});

describe("a row's state", () => {
  it('takes its tone from status first, then an unread reply', () => {
    expect(stateTone(agent({ status: 'blocked', unread: true }))).toBe('blocked');
    expect(stateTone(agent({ status: 'working', unread: true }))).toBe('working');
    expect(stateTone(agent({ unread: true }))).toBe('unread');
    expect(stateTone(agent({}))).toBe('idle');
    expect(stateTone({ kind: 'terminal', status: 'idle', unread: true })).toBe('idle');
  });

  it("is worded as the timeline's readout words it", () => {
    expect(stateWord(agent({ status: 'working' }))).toBe('working');
    expect(stateWord(agent({}))).toBe('idle');
    expect(stateWord(agent({ unread: true }))).toBe('reply unseen');
    expect(stateWord(agent({ status: 'blocked', wait: { kind: 'permission', since: 0 } }))).toBe(
      'blocked · permission',
    );
    expect(stateWord(agent({ status: 'blocked' }))).toBe('blocked · failed');
    expect(stateWord({ kind: 'terminal', status: 'working', unread: false })).toBe('running');
    expect(stateWord({ kind: 'terminal', status: 'idle', unread: false })).toBe('quiet');
  });
});

describe('receding', () => {
  it('knows when every row is receded, and that no rows is not that', () => {
    expect(everyReceded([])).toBe(false);
    expect(everyReceded([{ receded: true }, { receded: true }])).toBe(true);
    expect(everyReceded([{ receded: true }, { receded: false }])).toBe(false);
    expect(everyReceded([{ receded: true }, {}])).toBe(false);
  });

  it('settles a shown row at full weight, a receded one faint, and fainter when all are', () => {
    expect(recedeTarget(false, true)).toBe(1);
    expect(recedeTarget(true, false)).toBe(RECEDED_OPACITY);
    expect(recedeTarget(true, true)).toBe(RECEDED_EMPTY_OPACITY);
  });

  it('steps linearly and lands exactly on the target', () => {
    const step = approachRecede(1, RECEDED_OPACITY, 24);
    expect(step).toBeCloseTo(1 - 0.078, 10);
    expect(approachRecede(0.23, RECEDED_OPACITY, 24)).toBe(RECEDED_OPACITY);
    expect(approachRecede(0.5, 1, -10)).toBe(0.5);
  });
});
