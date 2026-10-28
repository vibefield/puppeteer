import { describe, expect, it } from 'vitest';
import type { AgentView, MonitorCost } from '@vibefield/puppeteer-view-sdk';
import { agentViewFixture, type AgentViewFixturePartial } from '@vibefield/puppeteer-view-sdk/testing';
import { OPENING_QUIET_MS, bubbleModel, workingShares, type SwarmBubbleModel } from './bubble-model.js';
import { DEFAULT_SWARM_PARAMETERS } from './swarm-parameters.js';
import { SWARM_WEIGHT } from './weight.js';

// What a body says, from an `AgentView` alone (MV-5): the backend's facts as the
// row carries them, worded by the toolkit. The cases are the legacy suite's,
// said over the model; where M4 changed a line it is named.

const NOW = Date.parse('2026-09-06T10:00:00.000Z');
const AT = NOW - 5_000;
const parameters = DEFAULT_SWARM_PARAMETERS;
const MINI = { id: 'mini', name: 'studio-mini', self: false } as const;

/** A bare terminal on this desktop, in `puppeteer`, at its prompt. */
function terminal(partial: AgentViewFixturePartial = {}): AgentView {
  return agentViewFixture({
    id: 'a',
    kind: 'terminal',
    createdAt: NOW,
    statusSince: AT,
    project: { name: 'puppeteer', seq: undefined },
    detail: 'Editing tokens.css',
    colour: '#6366f1',
    activity: { kind: 'shell-idle' },
    ...partial,
  });
}

/** An observed agent (Imposter, Fable 5.1) in `puppeteer`. */
function agent(partial: AgentViewFixturePartial = {}): AgentView {
  return agentViewFixture({
    id: 'a',
    createdAt: NOW,
    statusSince: AT,
    project: { name: 'puppeteer', seq: 0 },
    detail: 'Editing tokens.css',
    colour: '#6366f1',
    provider: { id: 'imposter', label: 'Imposter' },
    model: 'Fable 5.1',
    ...partial,
  });
}

/** A burn as the backend carries it: USD an hour, from Core's per-minute rate. */
const burning = (perMinute: number, coverage: MonitorCost['coverage'] = 'complete', usd = 0): MonitorCost => ({
  usd,
  coverage,
  burnPerHour: perMinute * 60,
});

describe('bubbleModel', () => {
  it('addresses the physical body while retaining the row identity for actions and usage', () => {
    const row = Object.assign(agent({ id: 'run', status: 'working' }), { visualId: 'shell' });
    const model = bubbleModel({ agent: row, parameters, nowMs: NOW, unread: false });
    expect(model.id).toBe('shell');
    expect(row.id).toBe('run');
    expect(workingShares([row]).has('run')).toBe(true);
    expect(workingShares([row]).has('shell')).toBe(false);
    expect(bubbleModel({ agent: agent({ id: 'ordinary' }), parameters, nowMs: NOW, unread: false }).id).toBe(
      'ordinary',
    );
  });

  it('draws an unclaimed idle terminal as a hollow with the folder and "empty"', () => {
    const model = bubbleModel({ agent: terminal({ status: 'idle' }), parameters, nowMs: NOW, unread: false });
    expect(model.state).toBe('terminal-empty');
    expect(model.hollow).toBe(true);
    expect(model.running).toBe(false);
    expect(model.radius).toBe(50);
    // One line, the folder then the name, as every other body reads it; a
    // terminal has no project, so its folder wears the ink.
    expect(model.copy.map((line) => line.key)).toEqual(['name', 'sub']);
    expect(model.copy[0]!.tone).toBe('ink');
    expect(model.copy[0]!.lead).toMatchObject({ kind: 'icon', icon: 'folder', tone: 'ink' });
    expect(model.copy[1]!.text).toBe('empty');
    expect(model.ring).toBeUndefined();
    expect(model.watermark).toBeUndefined();
    // a terminal's line is the backend's own (M4 changes nothing of it)
    expect(model.title).toBe('Editing tokens.css');
  });

  it('draws a terminal running a job with the comet, "running", and the elapsed time', () => {
    const model = bubbleModel({
      agent: terminal({ status: 'working', activity: { kind: 'foreground-job' } }),
      parameters,
      nowMs: NOW,
      unread: false,
      runningSinceMs: NOW - 83_000,
    });
    expect(model.state).toBe('terminal-running');
    expect(model.running).toBe(true);
    expect(model.copy.map((line) => line.text)).toEqual(['puppeteer', 'running', '1:23']);
  });

  it('a terminal in no folder is called `terminal`, as both hosts call it', () => {
    const model = bubbleModel({ agent: terminal({ project: { name: '' } }), parameters, nowMs: NOW, unread: false });
    expect(model.copy[0]!.text).toBe('terminal');
    expect(model.ariaLabel).toBe('terminal, unassigned terminal, idle');
  });

  it('never marks a terminal unread', () => {
    const model = bubbleModel({ agent: terminal(), parameters, nowMs: NOW, unread: true });
    expect(model.unread).toBe(false);
  });

  it('puts an unread reply itself in the name’s place, and fills the body blue behind it', () => {
    const model = bubbleModel({
      agent: agent({
        effort: { value: 'high', intent: 'configured' },
        reply: { text: 'Done: two tests fixed.\nDetails below.', at: AT, final: true },
      }),
      parameters,
      nowMs: NOW,
      unread: true,
    });
    expect(model.state).toBe('idle');
    expect(model.radius).toBe(50);
    // Three lines: the project above, what arrived, the model. Nothing after it.
    expect(model.copy.map((line) => line.key)).toEqual(['name', 'state', 'model']);
    // The project moves above in label type: its folder turns solid and keeps
    // full strength, while its NAME steps back to a supporting rung, because the
    // name is no longer what the body is telling you.
    expect(model.copy[0]!.text).toBe('puppeteer');
    expect(model.copy[0]!.style.size).toBe(7.5);
    expect(model.copy[0]!.opacity).toBe(SWARM_WEIGHT.supporting);
    expect(model.copy[0]!.lead).toMatchObject({
      kind: 'icon',
      icon: 'folder-solid',
      tone: 'accent',
      opacity: SWARM_WEIGHT.title,
    });
    // The reply's own words behind the chat mark. The state's colour is the
    // body's GROUND now, so the words are the theme's ink like every other
    // body's — light on a dark theme, dark on a light one.
    expect(model.copy[1]!.text).toBe('Done: two tests fixed.');
    expect(model.copy[1]!.tone).toBe('ink');
    expect(model.copy[1]!.lead).toMatchObject({ kind: 'icon', icon: 'message' });
    expect(model.copy[1]!.lead?.tone).toBeUndefined();
    expect(model.copy[2]!.text).toBe('Fable 5.1 · high');
    // Launch intent, no provider evidence yet: italic.
    expect(model.copy[2]!.style.italic).toBe(true);
    expect(model.unread).toBe(true);
    expect(model.light).toBe('blue');
    expect(model.ariaLabel.endsWith(', new message: Done: two tests fixed.')).toBe(true);
  });

  it('falls back to the words “new message” with no reply to show, and says nothing once read', () => {
    const model = bubbleModel({ agent: agent(), parameters, nowMs: NOW, unread: true });
    expect(model.copy.map((line) => line.key)).toEqual(['name', 'state', 'model']);
    expect(model.copy[1]!.text).toBe('new message');
    const read = bubbleModel({ agent: agent(), parameters, nowMs: NOW, unread: false });
    expect(read.copy.map((line) => line.key)).toEqual(['name', 'model']);
    // Read and idle: the name keeps the full size, the outlined folder, and no light.
    expect(read.copy[0]!.style.size).toBe(12);
    expect(read.copy[0]!.opacity).toBe(SWARM_WEIGHT.title);
    expect(read.copy[0]!.lead).toMatchObject({ kind: 'icon', icon: 'folder', tone: 'accent' });
    expect(read.light).toBeUndefined();
  });

  it('gives a working agent the larger body, branch, name, model · effort, the burn, the ring, and both figures', () => {
    const model = bubbleModel({
      agent: agent({
        status: 'working',
        activity: { kind: 'tool', line: 'Editing tokens.css', since: AT },
        context: { usedPercent: 62.7 },
        cost: burning(0.52, 'complete', 1.24),
        effort: { value: 'high', intent: 'observed' },
        project: { name: 'puppeteer', seq: 0, branch: 'swarm' },
      }),
      parameters,
      nowMs: NOW,
      unread: false,
    });
    expect(model.state).toBe('working');
    expect(model.radius).toBe(60);
    expect(model.copy.map((line) => line.key)).toEqual(['branch', 'name', 'model']);
    expect(model.copy[0]!.text).toBe('swarm');
    expect(model.copy[0]!.lead?.tone).toBe('green');
    expect(model.copy[1]!.tone).toBe('ink');
    expect(model.copy[2]!.text).toBe('Fable 5.1 · high');
    expect(model.copy[2]!.style.italic).toBeUndefined();
    expect(model.ring).toEqual({ percent: 62, hot: false });
    expect(model.figures).toEqual({
      top: { text: '62%', hot: false, none: false },
      bottom: { text: '~$1.24', hot: false, none: false },
    });
    // The bottom figure is the backend's corrected total; the burn is Core's own
    // live rate on the fixed ladder — $0.52/min is the third step.
    expect(model.burn).toEqual({ lit: 3, priced: true });
    expect(model.title.endsWith('· $31/hr')).toBe(true);
    expect(model.ariaLabel.endsWith(', burning $31/hr')).toBe(true);
    expect(model.watermark?.sprite).toBe('imposter');
  });

  it('lights the burn ladder by the rate, and leaves it unread where nothing prices the work', () => {
    const working = (cost: MonitorCost) =>
      bubbleModel({ agent: agent({ status: 'working', cost }), parameters, nowMs: NOW, unread: false });
    // The steps: under 5c calm, then 5c, 15c, 40c and a dollar a minute.
    expect(working(burning(0.04)).burn).toEqual({ lit: 0, priced: true });
    expect(working(burning(0.05)).burn).toEqual({ lit: 1, priced: true });
    expect(working(burning(0.39)).burn).toEqual({ lit: 2, priced: true });
    expect(working(burning(0.4)).burn).toEqual({ lit: 3, priced: true });
    expect(working(burning(12)).burn).toEqual({ lit: 4, priced: true });
    // A priced session that has not spent lately is calm; one with no pricing
    // lane at all is unread, and never reads as calm.
    expect(working({ usd: 0, coverage: 'complete' }).burn).toEqual({ lit: 0, priced: true });
    const unpriced = working(burning(9, 'unavailable'));
    expect(unpriced.burn).toEqual({ lit: 0, priced: false });
    expect(unpriced.title.endsWith('· —/hr')).toBe(true);
    expect(unpriced.figures?.bottom).toEqual({ text: '—', hot: false, none: true });
    // Partial coverage still prices what it saw, and says so on the figure.
    const partial = working(burning(0.2, 'partial', 3.5));
    expect(partial.burn).toEqual({ lit: 2, priced: true });
    expect(partial.figures?.bottom?.text).toBe('~$3.50+');
  });

  it('grows a working body from the working size to the largest by its share of the working sessions', () => {
    const input = { agent: agent({ status: 'working' }), parameters, nowMs: NOW, unread: false };
    expect(bubbleModel(input).radius).toBe(60);
    expect(bubbleModel({ ...input, workingShare: 0.5 }).radius).toBe(70);
    expect(bubbleModel({ ...input, workingShare: 1 }).radius).toBe(80);
  });

  it('places working sessions by estimated USD, least 0 and most 1, and leaves a lone session at 0', () => {
    const working = (id: string, usd: number): AgentView =>
      agent({ id, status: 'working', cost: { usd, coverage: 'complete' } });
    const shares = workingShares([
      working('a', 100),
      working('b', 400),
      working('c', 1300),
      { ...working('d', 9000), status: 'idle' },
      // a terminal never counts
      terminal({ id: 't', status: 'working' }),
    ]);
    expect([...shares.entries()]).toEqual([
      ['a', 0],
      ['b', 0.25],
      ['c', 1],
    ]);
    // an unpriced total counts as nothing spent, as the legacy ledger's missing total did: the least of the sessions
    const unpriced = { ...working('u', 5000), cost: { usd: 5000, coverage: 'unavailable' as const } };
    expect([...workingShares([working('a', 100), unpriced]).entries()]).toEqual([
      ['a', 1],
      ['u', 0],
    ]);
    expect([...workingShares([working('a', 100)]).values()]).toEqual([0]);
  });

  it('holds a blocked agent at the idle size, lights it orange, and says what it waits on', () => {
    const model = bubbleModel({
      agent: agent({
        status: 'blocked',
        wait: { kind: 'permission', since: AT, tool: 'Bash' },
        context: { usedPercent: 88 },
        reply: { text: 'May I run pnpm test?', at: AT, final: true },
      }),
      parameters,
      nowMs: NOW,
      unread: false,
    });
    expect(model.state).toBe('blocked');
    expect(model.radius).toBe(50);
    expect(model.light).toBe('orange');
    expect(model.blockerKind).toBe('permission');
    expect(model.copy.map((line) => line.key)).toEqual(['name', 'state', 'model']);
    // The permission's own evidence — the tool it wants — before the reply's words (M14's chain).
    expect(model.copy[1]!.text).toBe('Bash');
    expect(model.copy[1]!.tone).toBe('ink');
    expect(model.copy[1]!.lead).toMatchObject({ kind: 'icon', icon: 'permission' });
    expect(model.copy[1]!.lead?.tone).toBeUndefined();
    expect(model.ariaLabel.endsWith(', permission: Bash')).toBe(true);
    expect(model.ring).toEqual({ percent: 88, hot: true });
    expect(model.figures).toBeUndefined();
  });

  it('asks the question as it was asked, and names the blocker when there is nothing to quote', () => {
    const model = bubbleModel({
      agent: agent({
        status: 'blocked',
        wait: { kind: 'question', since: AT, question: 'Which key should the export use?' },
      }),
      parameters,
      nowMs: NOW,
      unread: false,
    });
    expect(model.copy.map((line) => line.key)).toEqual(['name', 'state', 'model']);
    const state = model.copy.find((line) => line.key === 'state');
    expect(state?.text).toBe('Which key should the export use?');
    expect(state?.tone).toBe('ink');
    expect(state?.lead).toMatchObject({ kind: 'icon', icon: 'question' });

    const unnamed = bubbleModel({
      agent: agent({ status: 'blocked', wait: { kind: 'question', since: AT } }),
      parameters,
      nowMs: NOW,
      unread: false,
    });
    expect(unnamed.copy.find((line) => line.key === 'state')?.text).toBe('question');
    // a wait the views do not draw, or none at all: the body is blocked with no words of its own
    const other = bubbleModel({
      agent: agent({ status: 'blocked', wait: { kind: 'sandbox', since: AT } }),
      parameters,
      nowMs: NOW,
      unread: false,
    });
    expect(other.blockerKind).toBeUndefined();
    expect(other.copy.find((line) => line.key === 'state')).toMatchObject({
      text: 'blocked',
      lead: { kind: 'icon', icon: 'failure' },
    });
    expect(other.light).toBe('orange');
  });

  it('carries the pane link, the stale flag, and the accessible copy', () => {
    const model = bubbleModel({
      agent: agent({ stale: true, colour: '#ec4899', attachment: { panes: 1, colour: '#22cc88' } }),
      parameters,
      nowMs: NOW,
      unread: false,
    });
    expect(model.stale).toBe(true);
    // The band is the pane's colour; the project's colour reaches the body in one
    // place only, the folder before its name.
    expect(model.linked).toBe('#22cc88');
    expect(model.accent).toBe('#ec4899');
    expect(model.copy.find((line) => line.key === 'name')?.lead).toMatchObject({
      kind: 'icon',
      icon: 'folder',
      tone: 'accent',
    });
    expect(model.copy.flatMap((line) => (line.lead?.tone === 'accent' ? [line.key] : []))).toEqual(['name']);
    expect(
      bubbleModel({ agent: agent({ colour: '#ec4899' }), parameters, nowMs: NOW, unread: false }).linked,
    ).toBeUndefined();
    // M4: the line under the name is the toolkit's one rule (reply-first): an idle agent with no reply says its
    // status, where the legacy body repeated the host's composed line.
    expect(model.ariaLabel).toBe('puppeteer, Fable 5.1, idle: idle, CTX:--%');
    expect(model.title).toBe('puppeteer · Fable 5.1 · idle');
    const replied = bubbleModel({
      agent: agent({ reply: { text: 'Shipped.', at: AT } }),
      parameters,
      nowMs: NOW,
      unread: false,
    });
    expect(replied.title).toBe('puppeteer · Fable 5.1 · Shipped.');
  });

  it('draws no live fact for a run not heard from yet: its line says so, the rest waits', () => {
    const starting = bubbleModel({
      agent: agent({
        observed: false,
        detail: 'starting',
        effort: { value: 'high', intent: 'configured' },
        reply: { text: 'never' },
        cost: burning(1, 'complete', 9),
      }),
      parameters,
      nowMs: NOW,
      unread: true,
    });
    expect(starting.title).toBe('puppeteer · Fable 5.1 · starting');
    expect(starting.copy.map((line) => line.key)).toEqual(['name', 'state', 'model']);
    expect(starting.copy[1]!.text).toBe('new message');
    expect(starting.copy[2]!.text).toBe('Fable 5.1');
    const pending = bubbleModel({
      agent: agent({ observed: false, pending: true, status: 'working', detail: 'unobserved · resumes when idle' }),
      parameters,
      nowMs: NOW,
      unread: false,
    });
    expect(pending.figures?.bottom).toEqual({ text: '—', hot: false, none: true });
    expect(pending.burn).toEqual({ lit: 0, priced: false });
    expect(pending.title).toBe('puppeteer · Fable 5.1 · unobserved · resumes when idle · —/hr');
  });
});

describe("a peer's session (a row from another desktop)", () => {
  const remoteRow = (writable: boolean): AgentView =>
    agentViewFixture({
      id: 'r1',
      kind: 'terminal',
      createdAt: 0,
      status: 'idle',
      project: { name: 'mesh-console' },
      detail: '/Projects/mesh-console',
      colour: '#6366f1',
      device: MINI,
      writable,
    });
  const model = (writable: boolean) =>
    bubbleModel({
      agent: remoteRow(writable),
      parameters: DEFAULT_SWARM_PARAMETERS,
      nowMs: NOW,
      unread: false,
      workingShare: 0,
    });
  // James, 2026-10-28: "all the peer session should be writable, which is the default and universal setting, so no
  // need to mark things like writable or read only." The row's `writable` stays as data (M41); no body says it.
  const WRITE_WORDS = /writ|read.only|may type/i;
  const said = (body: SwarmBubbleModel): string =>
    [...body.copy.map((line) => line.text), body.ariaLabel, body.title].join(' | ');

  it('names the peer FIRST in the accessible name, and says nothing after its status', () => {
    for (const writable of [false, true]) {
      expect(model(writable).ariaLabel).toBe('on studio-mini, mesh-console, remote session, idle');
    }
  });

  it('wears its host on the body by the desktop’s name alone, so it cannot read as a local terminal', () => {
    for (const writable of [false, true]) {
      const body = model(writable);
      expect(body.copy.find((line) => line.key === 'host')?.text).toBe('studio-mini');
      expect(body.title).toBe('studio-mini · /Projects/mesh-console');
      // No write word anywhere, whatever the row's `writable` says: not on the body, not in the hover, not spoken.
      expect(said(body)).not.toMatch(WRITE_WORDS);
    }
  });

  it('draws a peer’s agent from the facts its row carries, as it draws this desktop’s (M9)', () => {
    const peer = bubbleModel({
      agent: agent({
        device: MINI,
        status: 'working',
        context: { usedPercent: 42 },
        cost: burning(0.2, 'complete', 2),
        effort: { value: 'medium', intent: 'observed' },
      }),
      parameters,
      nowMs: NOW,
      unread: false,
    });
    expect(peer.ring).toEqual({ percent: 42, hot: false });
    expect(peer.figures?.top?.text).toBe('42%');
    expect(peer.burn).toEqual({ lit: 2, priced: true });
    expect(peer.copy.find((line) => line.key === 'model')?.text).toBe('Fable 5.1 · medium');
    // the line under the name leads with the desktop's name (the toolkit's rule for a peer)
    expect(peer.title).toBe('puppeteer · Fable 5.1 · studio-mini · working · $12/hr');
  });

  describe('a peer’s agent wears the host line too (Q16)', () => {
    const peerAgent = (partial: AgentViewFixturePartial) =>
      bubbleModel({ agent: agent({ device: MINI, ...partial }), parameters, nowMs: NOW, unread: false });

    it('as its last line, the desktop’s name alone, drawn as a peer terminal’s is', () => {
      const idle = peerAgent({ writable: true });
      expect(idle.copy.map((line) => line.key)).toEqual(['name', 'model', 'host']);
      // One host line, one look: the terminal's label style, at the supporting weight, after the same gap.
      expect(idle.copy.at(-1)).toEqual(model(true).copy.find((line) => line.key === 'host'));
      const working = peerAgent({
        writable: false,
        status: 'working',
        project: { name: 'puppeteer', seq: 0, branch: 'main' },
        cost: burning(0.2, 'complete', 2),
      });
      expect(working.copy.map((line) => line.key)).toEqual(['branch', 'name', 'model', 'host']);
      expect(working.copy.at(-1)?.text).toBe('studio-mini');
      const blocked = peerAgent({ status: 'blocked', wait: { kind: 'permission', since: AT, tool: 'Bash' } });
      expect(blocked.copy.map((line) => line.key)).toEqual(['name', 'state', 'model', 'host']);
    });

    it('says no write word: its accessible name and hover are a local agent’s, its line naming the desktop', () => {
      const idle = peerAgent({ writable: false });
      expect(idle.ariaLabel).toBe('puppeteer, Fable 5.1, idle: studio-mini · idle, CTX:--%');
      const working = peerAgent({
        writable: true,
        status: 'working',
        context: { usedPercent: 42 },
        cost: burning(0.2),
      });
      expect(working.ariaLabel).toBe('puppeteer, Fable 5.1, working: studio-mini · working, CTX:42%, burning $12/hr');
      const permission = { kind: 'permission', since: AT, tool: 'Bash' } as const;
      const blocked = peerAgent({ writable: false, status: 'blocked', wait: permission });
      expect(blocked.ariaLabel).toBe(
        'puppeteer, Fable 5.1, blocked: studio-mini · permission · Bash, CTX:--%, permission: Bash',
      );
      // The hover keeps its words: the project, the model, the desktop, its line.
      expect(idle.title).toBe('puppeteer · Fable 5.1 · studio-mini · idle');
      for (const body of [idle, working, blocked]) expect(said(body)).not.toMatch(WRITE_WORDS);
    });

    it('never on this desktop’s agents, which name no host', () => {
      const local = bubbleModel({ agent: agent({ writable: false }), parameters, nowMs: NOW, unread: false });
      expect(local.copy.some((line) => line.key === 'host')).toBe(false);
      expect(local.ariaLabel).toBe('puppeteer, Fable 5.1, idle: idle, CTX:--%');
    });
  });
});

describe('a birth on its way (the spawn bloom’s pending body)', () => {
  const opening = (agoMs: number, on?: string, row: AgentViewFixturePartial = {}) =>
    bubbleModel({
      agent: terminal({ project: { name: '~' }, status: 'idle', ...row }),
      parameters,
      nowMs: NOW,
      unread: false,
      opening: { sinceMs: NOW - agoMs, ...(on ? { on } : {}) },
    });

  it('reads empty and holds still for its first 320 ms: a fast birth shows no wait', () => {
    const model = opening(100);
    expect(model.pending).toEqual({ turning: false });
    expect(model.state).toBe('terminal-empty');
    expect(model.hollow).toBe(true);
    expect(model.running).toBe(false);
    expect(model.copy.map((line) => [line.key, line.text])).toEqual([
      ['name', '~'],
      ['sub', 'empty'],
    ]);
    expect(opening(OPENING_QUIET_MS - 1).pending).toEqual({ turning: false });
  });

  it('says it is opening, and turns, once the quiet has run out', () => {
    expect(OPENING_QUIET_MS).toBe(320);
    expect(opening(OPENING_QUIET_MS).pending).toEqual({ turning: true });
    const model = opening(900);
    expect(model.pending).toEqual({ turning: true });
    const sub = model.copy.find((line) => line.key === 'sub');
    expect(sub?.text).toBe('opening');
    // In the terminal's label style: 7 px 800 uppercase at the supporting weight.
    expect(sub?.style).toMatchObject({ size: 7, weight: 800, transform: 'uppercase' });
    expect(sub?.opacity).toBe(SWARM_WEIGHT.supporting);
  });

  it('names the peer it opens on', () => {
    expect(opening(900, 'mini').copy.find((line) => line.key === 'sub')?.text).toBe('opening on mini');
    expect(opening(100, 'mini').copy.find((line) => line.key === 'sub')?.text).toBe('empty');
    expect(opening(900, 'mini').ariaLabel).toBe('~, new terminal, opening on mini');
    expect(opening(100).ariaLabel).toBe('~, new terminal, opening');
  });

  it('has no job yet, whatever its row says', () => {
    const model = opening(900, undefined, { status: 'working', activity: { kind: 'foreground-job' } });
    expect(model.running).toBe(false);
    expect(model.state).toBe('terminal-empty');
    expect(model.copy.map((line) => line.key)).toEqual(['name', 'sub']);
  });

  it('is no birth without `opening`, and an agent’s row ignores it', () => {
    expect(bubbleModel({ agent: terminal(), parameters, nowMs: NOW, unread: false }).pending).toBeUndefined();
    const withAgent = bubbleModel({
      agent: agent(),
      parameters,
      nowMs: NOW,
      unread: false,
      opening: { sinceMs: NOW - 900 },
    });
    expect(withAgent.pending).toBeUndefined();
    expect(withAgent.hollow).toBe(false);
  });
});

describe('the profile line (a terminal born under an Agent Profile)', () => {
  const profiled = (profile: Parameters<typeof bubbleModel>[0]['profile'], row: AgentViewFixturePartial = {}) =>
    bubbleModel({
      agent: terminal({ project: { name: '~' }, status: 'idle', ...row }),
      parameters,
      nowMs: NOW,
      unread: false,
      profile,
    });
  const lineOf = (model: ReturnType<typeof bubbleModel>) => model.copy.find((line) => line.key === 'profile');

  it('names the default profile under its glyph, drawn filled, in the terminal’s label style', () => {
    const model = profiled({ label: 'Work', glyph: 'briefcase', kind: 'managed', isDefault: true });
    expect(model.copy.map((line) => line.key)).toEqual(['name', 'sub', 'profile']);
    const line = lineOf(model)!;
    expect(line.text).toBe('Work');
    // LABEL_STACKED: 7 px 800 uppercase, 0.1 tracking, at the supporting weight.
    expect(line.style).toEqual({ size: 7, weight: 800, transform: 'uppercase', letterSpacing: 0.1 });
    expect(line.opacity).toBe(SWARM_WEIGHT.supporting);
    expect(line.tone).toBe('ink');
    // The glyph leads like the folder: 1.5 × the size, then a 3 px gap.
    expect(line.lead).toEqual({ kind: 'icon', icon: 'profile:briefcase:filled', size: 10.5, gap: 3 });
    expect(model.ariaLabel).toBe('~, unassigned terminal, idle, under Work');
  });

  it('outlines a managed profile that is not the default', () => {
    expect(lineOf(profiled({ label: 'Personal', glyph: 'house', kind: 'managed' }))?.lead?.icon).toBe('profile:house');
  });

  it('draws the laptop for the native set, whatever glyph it carries', () => {
    const line = lineOf(profiled({ label: 'This Mac', glyph: 'rocket', kind: 'native', isDefault: true }));
    expect(line?.text).toBe('This Mac');
    expect(line?.lead?.icon).toBe('profile:laptop:filled');
    expect(lineOf(profiled({ label: 'Default', kind: 'native' }))?.lead?.icon).toBe('profile:laptop');
  });

  it('falls back to the star for a token this build does not draw', () => {
    expect(lineOf(profiled({ label: 'Odd', glyph: 'telescope' }))?.lead?.icon).toBe('profile:star');
  });

  it('draws no profile line without a profile', () => {
    const model = profiled(undefined);
    expect(lineOf(model)).toBeUndefined();
    expect(model.ariaLabel).toBe('~, unassigned terminal, idle');
  });

  it('sits after the running line and its clock, and before a peer’s host line', () => {
    const running = bubbleModel({
      agent: terminal({ status: 'working', activity: { kind: 'foreground-job' } }),
      parameters,
      nowMs: NOW,
      unread: false,
      runningSinceMs: NOW - 83_000,
      profile: { label: 'Work', glyph: 'briefcase' },
    });
    expect(running.copy.map((line) => line.key)).toEqual(['name', 'command', 'elapsed', 'profile']);
    const peer = profiled({ label: 'Personal', glyph: 'house' }, { device: MINI });
    expect(peer.copy.map((line) => line.key)).toEqual(['name', 'sub', 'profile', 'host']);
  });

  it('names the profile a birth on its way is opening under', () => {
    const model = bubbleModel({
      agent: terminal({ project: { name: '~' }, status: 'idle' }),
      parameters,
      nowMs: NOW,
      unread: false,
      opening: { sinceMs: NOW - 900 },
      profile: { label: 'Work', glyph: 'briefcase', isDefault: true },
    });
    expect(model.copy.map((line) => [line.key, line.text])).toEqual([
      ['name', '~'],
      ['sub', 'opening'],
      ['profile', 'Work'],
    ]);
  });
});
