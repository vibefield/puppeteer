import { describe, expect, it } from 'vitest';
import type { AgentView } from '@vibecook/puppeteer-view-sdk';
import { agentViewFixture, type AgentViewFixturePartial } from '@vibecook/puppeteer-view-sdk/testing';
import { formatClock } from '@vibecook/puppeteer-view-sdk/toolkit';
import {
  axisMoney,
  est,
  fitWords,
  modelOf,
  money,
  NOT_RECORDED,
  perHour,
  printedBurn,
  spendNames,
  spendStateAt,
  stateWords,
  taskOf,
} from './spend-words.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-02T17:00:00.000Z');

function row(id: string, project: string, extra: AgentViewFixturePartial = {}): AgentView {
  return agentViewFixture({
    id,
    project: { name: project },
    status: 'idle',
    provider: { id: 'claude', label: 'Claude' },
    ...extra,
  });
}

describe('the spend words', () => {
  it('prints money as the swarm does: a tilde, a plus when partial, a dash with no price', () => {
    expect(est(62.871, false)).toBe('~$62.87');
    expect(est(7.03, true)).toBe('~$7.03+');
    expect(est(undefined, false)).toBe('—');
    expect(money(0.004)).toBe('$0.004');
    expect(money(1234.5)).toBe('$1,235');
  });

  it('prints the burn by the hour and the axis as short as its step', () => {
    expect(perHour(0.12)).toBe('$7.2/hr');
    expect(perHour(0.45)).toBe('$27/hr');
    expect(perHour(0)).toBe('$0/hr');
    expect(axisMoney(0, 10)).toBe('$0');
    expect(axisMoney(20, 10)).toBe('$20');
    expect(axisMoney(0.4, 0.2)).toBe('$0.4');
  });

  it('tells siblings apart by agent, or by the first words of the line under their names (review must-fix 1)', () => {
    const said = (text: string) => ({ reply: { text, final: true } });
    const a = row('a', 'rosetta', {
      ...said('Grants expire with the session.'),
      provider: { id: 'codex', label: 'Codex' },
    });
    const b = row('b', 'rosetta', said('Rebuilt the session index.'));
    const c = row('c', 'rosetta', said('Tidied the timeline route docs.'));
    const d = row('d', 'notes');
    const names = spendNames([a, b, c, d]);
    expect(names.get('d')!.one).toBe('notes');
    expect(names.get('a')!.name).toBe('rosetta');
    expect(names.get('a')!.one).toBe('rosetta · codex');
    expect(names.get('b')!.one).toBe('rosetta · Rebuilt the');
    expect(names.get('c')!.task).toBe('Tidied the timeline route docs.');
  });

  it('says the line under the name where the held row printed its task: M4’s rule, the wait, else the reply (M178)', () => {
    // The model carries no task (the held view read the terminal's title): the toolkit's `detailLine` says the row.
    expect(taskOf(row('a', 'p', { status: 'working', reply: { text: 'Tightened the ledger reader.' } }))).toBe(
      'Tightened the ledger reader.',
    );
    expect(taskOf(row('a', 'p', { status: 'working', reply: { text: '✳ port the History view\nmore' } }))).toBe(
      'port the History view',
    );
    const permission = { kind: 'permission', since: NOW, tool: 'Bash', detail: 'git push' };
    expect(taskOf(row('a', 'p', { status: 'blocked', wait: permission, reply: { text: 'Pushing.' } }))).toBe(
      'permission · Bash',
    );
    // Another desktop's row leads with its desktop.
    const peer = { id: 'tower', name: 'tower', self: false };
    expect(taskOf(row('a', 'p', { status: 'working', device: peer, reply: { text: 'Sorting.' } }))).toBe(
      'tower · Sorting.',
    );
    // A line that only says the bare status (or the project) is none: the row falls back to its model, as held.
    expect(taskOf(row('a', 'p', { status: 'idle' }))).toBe('');
    expect(taskOf(row('a', 'p', { status: 'working' }))).toBe('');
    // The row's own `detail` (core's headline) is not what it says here.
    expect(taskOf(row('a', 'p', { status: 'idle', detail: 'tighten the ledger reader' }))).toBe('');
  });

  it('names the model the tooltip says: the run’s model, else its provider, then its branch', () => {
    expect(modelOf(row('a', 'p', { model: 'opus', project: { name: 'p', branch: 'main' } }))).toBe('opus · main');
    expect(modelOf(row('a', 'p', { project: { name: 'p', branch: null } }))).toBe('Claude');
  });

  it('fits a task at a word, never mid-word', () => {
    const measure = (text: string): number => text.length * 6;
    expect(fitWords('move the token store behind the grant', 120, measure)).toBe('move the token…');
    expect(fitWords('short', 120, measure)).toBe('short');
    expect(fitWords('unbreakable', 30, measure)).toBe('');
  });

  it('says when a row starts before it did (SV-D15), its state from when it began, and nothing the row does not say', () => {
    const born = NOW - 60 * MIN;
    const blocked = row('a', 'p', {
      status: 'blocked',
      createdAt: born,
      statusSince: NOW - 20 * MIN,
      wait: { kind: 'question', since: NOW - 20 * MIN, question: 'Merge it?' },
    });
    const r = { agent: blocked, bornMs: born };
    const before = spendStateAt(r, born - 5 * MIN, NOW);
    expect(before.key).toBe('before');
    expect(stateWords(before, born - 5 * MIN, undefined)).toEqual({
      text: `starts ${formatClock(born)}`,
      tone: 'muted',
    });
    // From when its state began it is that state, aged to the moment.
    const waiting = spendStateAt(r, NOW - 9 * MIN, NOW);
    expect(waiting).toMatchObject({ key: 'blocked', glyph: 'question', sinceMs: NOW - 20 * MIN });
    expect(stateWords(waiting, NOW - 9 * MIN, undefined)).toEqual({ text: 'waiting · 11m', tone: 'attention' });
    expect(stateWords(spendStateAt(r, NOW, NOW), NOW, undefined).text).toBe('waiting · 20m');
    // Before that the row does not say, and the view keeps no record (runtime only).
    expect(spendStateAt(r, NOW - 30 * MIN, NOW).key).toBe('unknown');
    expect(stateWords({ key: 'idle', sinceMs: NOW - 62 * MIN }, NOW, undefined).text).toBe('idle · 1h 02m');
    expect(stateWords({ key: 'working', sinceMs: NOW - MIN }, NOW, 0.12)).toEqual({ text: '$7.2/hr', tone: 'live' });
  });

  it('draws a wait’s glyph from its kind, and names its words for the tooltip', () => {
    const wait = (kind: string, detail?: string): AgentView =>
      row('w', 'p', { status: 'blocked', wait: { kind, since: NOW, ...(detail ? { detail } : {}) } });
    const at = (agent: AgentView) => spendStateAt({ agent, bornMs: NOW - HOUR }, NOW, NOW);
    expect(at(wait('permission', 'Bash · git push'))).toMatchObject({ glyph: 'permission', words: 'Bash · git push' });
    expect(at(wait('failure'))).toMatchObject({ glyph: 'failure' });
    expect(at(wait('question'))).toMatchObject({ glyph: 'question' });
    // A kind the view does not know is drawn as the permission it most often is.
    expect(at(wait('elicitation'))).toMatchObject({ glyph: 'permission' });
  });

  it("prints a burn only where a row's words say one: working, or what a stretch nobody kept was spending", () => {
    const working = { key: 'working', sinceMs: NOW - MIN } as const;
    const unknown = { key: 'unknown', sinceMs: NOW - 5 * MIN } as const;
    expect(printedBurn(working, 0.12)).toBe(0.12);
    expect(printedBurn({ key: 'blocked', sinceMs: NOW - MIN }, 0.12)).toBeUndefined();
    expect(printedBurn(working, 0.0001)).toBeUndefined();
    expect(stateWords(working, NOW, 0.0001)).toEqual({ text: 'working · 1m', tone: 'live' });
    expect(stateWords(unknown, NOW - 5 * MIN, 0.12)).toEqual({ text: '$7.2/hr', tone: 'live' });
    expect(stateWords(unknown, NOW - 5 * MIN, undefined)).toEqual({ text: '', tone: 'muted' });
  });

  it('says an unseen reply in blue, and a row nobody recorded in so many words', () => {
    const unseen = { agent: row('b', 'p', { unread: true, statusSince: NOW - 5 * MIN }), bornMs: NOW - HOUR };
    const state = spendStateAt(unseen, NOW, NOW);
    expect(state).toMatchObject({ key: 'unseen', glyph: 'reply' });
    expect(stateWords(state, NOW, undefined).tone).toBe('info');
    expect(NOT_RECORDED).toEqual({ text: 'not recorded', tone: 'muted' });
  });
});
