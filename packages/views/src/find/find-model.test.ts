import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AgentVisualStatus } from '../monitor/agent-status.js';
import type { FindAgent } from './find-agent.js';
import type { HistorySearchHit, HistorySessionFacts } from './history-port.js';
import {
  buildFindRows,
  factsScore,
  fieldMatch,
  footSentence,
  lastActiveMs,
  liveScope,
  moveCursor,
  nativeSessionIdOf,
  parseSnippet,
  tokenize,
  whenLabel,
  whoSaidIt,
} from './find-model.js';

const NOW = Date.parse('2026-09-09T12:00:00.000Z');

function agent(input: {
  id: string;
  native?: string;
  project: string;
  branch?: string;
  model?: string;
  account?: string;
  status?: AgentVisualStatus;
  detail?: string;
  lastEvidenceAt?: string;
  startedAt?: string;
  createdAtMs?: number;
  terminal?: boolean;
}): FindAgent {
  const base: FindAgent = {
    id: input.id,
    createdAtMs: input.createdAtMs ?? NOW - 3_600_000,
    status: input.status ?? 'idle',
    project: input.project,
    detail: input.detail ?? '',
    color: '#123456',
  };
  if (input.terminal) return base;
  const monitor = {
    statusSince: input.lastEvidenceAt ?? new Date(NOW - 600_000).toISOString(),
    session: {
      ...(input.native ? { nativeSessionId: input.native } : {}),
      ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    },
    freshness: {
      ...(input.lastEvidenceAt ? { lastEvidenceAt: input.lastEvidenceAt } : {}),
    },
  };
  return {
    ...base,
    agent: {
      provider: { id: 'provider-x', label: 'Provider X' },
      ...(input.model ? { model: input.model } : {}),
      ...(input.account ? { account: input.account } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
      monitor,
      ...(input.native ? { nativeSessionId: input.native } : {}),
    },
  };
}

function facts(native: string, title: string): HistorySessionFacts {
  return {
    nativeSessionId: native,
    sessionId: `c-${native}`,
    rootSessionId: `c-${native}`,
    title,
    updatedAt: 1,
    streamState: 'indexed',
  };
}

function hit(native: string, timelineId: string, snippet: string, at = NOW - 1_000, kind = 'user'): HistorySearchHit {
  return {
    sessionId: `c-${native}`,
    rootSessionId: `c-${native}`,
    nativeSessionId: native,
    timelineId,
    kind,
    at,
    snippet,
  };
}

describe('tokenize and fieldMatch', () => {
  it('splits words, strips quotes, and ranks word starts over substrings over subsequences', () => {
    expect(tokenize('  Fuzzy "search"  ')).toEqual(['fuzzy', 'search']);
    expect(fieldMatch('vibe-field', 'field')).toBe(3);
    expect(fieldMatch('vibe-field', 'vibe')).toBe(3);
    expect(fieldMatch('puppeteer', 'pete')).toBe(2);
    expect(fieldMatch('infinite-canvas-engine', 'ice')).toBe(1);
    expect(fieldMatch('puppeteer', 'zz')).toBe(0);
    expect(fieldMatch('puppeteer', 'pr')).toBe(0);
    expect(fieldMatch('', 'a')).toBe(0);
  });
});

describe('factsScore', () => {
  it('requires every term to land somewhere and weights the title and folder highest', () => {
    const row = agent({ id: 'a', native: 'n-a', project: 'puppeteer', branch: 'feat/find', model: 'opus' });
    const titled = facts('n-a', 'Godview agent session fuzzy search');
    expect(factsScore(row, titled, ['fuzzy']).matched).toEqual(['title']);
    expect(factsScore(row, titled, ['fuzzy', 'find']).matched.sort()).toEqual(['branch', 'title']);
    expect(factsScore(row, titled, ['fuzzy', 'nomatch']).score).toBe(0);
    expect(factsScore(row, undefined, ['fuzzy']).score).toBe(0);
    expect(factsScore(row, undefined, ['puppet']).score).toBeGreaterThan(factsScore(row, undefined, ['opus']).score);
  });
});

describe('liveScope and nativeSessionIdOf', () => {
  it('collects native ids once and the earliest start with slack', () => {
    const early = new Date(NOW - 7_200_000).toISOString();
    const agents = [
      agent({ id: 'a', native: 'n-a', project: 'p', startedAt: early }),
      agent({ id: 'b', native: 'n-a', project: 'p' }),
      agent({ id: 'c', project: 'p', terminal: true }),
      agent({ id: 'd', native: 'n-d', project: 'q' }),
    ];
    const scope = liveScope(agents);
    expect(scope.nativeSessionIds).toEqual(['n-a', 'n-d']);
    expect(scope.afterMs).toBe(NOW - 7_200_000 - 5 * 60_000);
    expect(nativeSessionIdOf(agents[2]!)).toBeUndefined();
    expect(liveScope([agent({ id: 'x', project: 'p', terminal: true })])).toEqual({ nativeSessionIds: [] });
  });

  it('reads a mirror with no session or freshness, as a host may hand one (M47)', () => {
    // Core's mirror rides the wire as passthrough, so neither part is promised. VibeField once handed the sheet
    // the legacy shim's sketch, which has neither, and the throw in render blanked its window (build-mv M47).
    const sketch = { statusSince: new Date(NOW - 60_000).toISOString() };
    const base = agent({ id: 's', project: 'p' });
    const row: FindAgent = { ...base, agent: { ...base.agent!, monitor: sketch } };
    expect(nativeSessionIdOf(row)).toBeUndefined();
    expect(liveScope([row])).toEqual({ nativeSessionIds: [] });
    const named: FindAgent = { ...row, agent: { ...row.agent!, nativeSessionId: 'n-s' } };
    expect(liveScope([named]).nativeSessionIds).toEqual(['n-s']);
    expect(lastActiveMs(named, NOW)).toBe(NOW - 60_000);
  });
});

describe('buildFindRows', () => {
  it('keeps the host row and its additional facts for selection', () => {
    const hosted = { ...agent({ id: 'hosted', project: 'p' }), hostSessionId: 'pty-1' };
    const [row] = buildFindRows({ agents: [hosted], facts: new Map(), hits: [], query: '', nowMs: NOW });
    expect(row?.agent).toBe(hosted);
    expectTypeOf(row!.agent.hostSessionId).toEqualTypeOf<string>();
  });

  const a = agent({
    id: 'a',
    native: 'n-a',
    project: 'vibe-field',
    branch: 'main',
    model: 'opus',
    lastEvidenceAt: new Date(NOW - 60_000).toISOString(),
  });
  const b = agent({
    id: 'b',
    native: 'n-b',
    project: 'vibe-field',
    branch: 'widgets',
    model: 'opus',
    lastEvidenceAt: new Date(NOW - 3_600_000).toISOString(),
  });
  const c = agent({ id: 'c', native: 'n-c', project: 'rosetta', model: 'sonnet', status: 'blocked' });
  const shell = agent({ id: 's', project: 'rosetta', terminal: true });
  const known = new Map([
    ['n-a', facts('n-a', 'Live surface structure exploration')],
    ['n-b', facts('n-b', 'Widget card redesign')],
  ]);

  it('lists every agent, newest activity first, when nothing is typed', () => {
    const rows = buildFindRows({ agents: [c, b, a, shell], facts: known, hits: [], query: '', nowMs: NOW });
    expect(rows.map((row) => row.agent.id)).toEqual(['a', 'c', 'b']);
    expect(rows[0]?.title).toBe('Live surface structure exploration');
  });

  it('keeps only agents the facts or the words reach, and ranks words above a loose fact', () => {
    const hits = [hit('n-b', 't1', 'the [widget] card'), hit('n-b', 't2', 'a [widget] again', NOW - 5_000, 'agent')];
    const rows = buildFindRows({ agents: [a, b, c, shell], facts: known, hits, query: 'widget', nowMs: NOW });
    expect(rows.map((row) => row.agent.id)).toEqual(['b']);
    expect(rows[0]?.hits.map((entry) => entry.timelineId)).toEqual(['t1', 't2']);
    expect(rows[0]?.matched).toEqual(['title']);

    const byFolder = buildFindRows({ agents: [a, b, c], facts: known, hits: [], query: 'vibe', nowMs: NOW });
    expect(byFolder.map((row) => row.agent.id)).toEqual(['a', 'b']);

    const wordsOnly = buildFindRows({
      agents: [a, b, c],
      facts: known,
      hits: [hit('n-c', 't3', '[ledger] compaction')],
      query: 'ledger',
      nowMs: NOW,
    });
    expect(wordsOnly.map((row) => row.agent.id)).toEqual(['c']);
    expect(wordsOnly[0]?.factsScore).toBe(0);
  });

  it('drops hits it cannot attribute to a live run', () => {
    const orphan: HistorySearchHit = {
      sessionId: 'x',
      rootSessionId: 'x',
      timelineId: 't',
      kind: 'user',
      snippet: '[ledger]',
    };
    expect(buildFindRows({ agents: [a, b, c], facts: known, hits: [orphan], query: 'ledger', nowMs: NOW })).toEqual([]);
  });
});

describe('the words on a row', () => {
  it('parses match markers and leaves an unbalanced bracket as text', () => {
    expect(parseSnippet('the  [godview] app,\nwhen')).toEqual([
      { text: 'the ', match: false },
      { text: 'godview', match: true },
      { text: ' app, when', match: false },
    ]);
    expect(parseSnippet('array[0] and [open')).toEqual([
      { text: 'array', match: false },
      { text: '0', match: true },
      { text: ' and [open', match: false },
    ]);
    expect(whoSaidIt('user', 'Provider X')).toBe('you');
    expect(whoSaidIt('agent', 'Provider X')).toBe('Provider X');
    expect(whoSaidIt('notice', 'Provider X')).toBe('notice');
  });

  it('labels when in the reader’s own terms', () => {
    const today = new Date(NOW);
    today.setHours(9, 5, 0, 0);
    expect(whenLabel(today.getTime(), NOW)).toBe('09:05');
    expect(whenLabel(undefined, NOW)).toBe('—');
    const lastYear = new Date(NOW);
    lastYear.setFullYear(lastYear.getFullYear() - 1);
    expect(whenLabel(lastYear.getTime(), NOW)).toMatch(/\d{4}$/);
  });
});

describe('footSentence', () => {
  const ready = { reachable: true, readiness: 'ready' as const, protocolVersion: 18, checkedAt: 'now' };

  it('counts what it found and names every degraded state', () => {
    expect(
      footSentence({
        query: '',
        status: ready,
        rows: 3,
        hits: 0,
        scope: 3,
        answered: true,
        clipped: false,
        searching: false,
      }),
    ).toBe('3 live sessions');
    expect(
      footSentence({
        query: 'x',
        status: ready,
        rows: 2,
        hits: 5,
        scope: 3,
        answered: true,
        clipped: false,
        searching: false,
      }),
    ).toBe('2 agents · 5 matches');
    expect(
      footSentence({
        query: 'x',
        status: ready,
        rows: 1,
        hits: 1,
        scope: 3,
        answered: true,
        clipped: true,
        searching: false,
      }),
    ).toContain('first page only');
    expect(
      footSentence({
        query: 'x',
        status: ready,
        rows: 0,
        hits: 0,
        scope: 3,
        answered: false,
        clipped: false,
        searching: true,
      }),
    ).toContain('searching');
    expect(
      footSentence({
        query: 'x',
        status: { ...ready, readiness: 'building', progress: { done: 1, total: 4 } },
        rows: 0,
        hits: 0,
        scope: 3,
        answered: false,
        clipped: false,
        searching: false,
      }),
    ).toContain('indexing · 25%');
    expect(
      footSentence({
        query: 'x',
        status: { ...ready, readiness: 'catching-up' },
        rows: 1,
        hits: 1,
        scope: 3,
        answered: true,
        clipped: false,
        searching: false,
      }),
    ).toContain('catching up');
    expect(
      footSentence({
        query: '',
        status: { reachable: false, detail: 'no history daemon is listening', checkedAt: 'now' },
        rows: 3,
        hits: 0,
        scope: 3,
        answered: true,
        clipped: false,
        searching: false,
      }),
    ).toBe('3 live sessions · transcript search off · no history daemon is listening');
  });
});

describe('moveCursor', () => {
  it('clamps at both ends and starts from the top', () => {
    expect(moveCursor(-1, 'ArrowDown', 3)).toBe(0);
    expect(moveCursor(2, 'ArrowDown', 3)).toBe(2);
    expect(moveCursor(0, 'ArrowUp', 3)).toBe(0);
    expect(moveCursor(1, 'End', 3)).toBe(2);
    expect(moveCursor(1, 'Home', 3)).toBe(0);
    expect(moveCursor(0, 'ArrowDown', 0)).toBe(-1);
  });
});
