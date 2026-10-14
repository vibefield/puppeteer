import { describe, expect, it } from 'vitest';
import type { AgentView, MonitorCost } from '@vibecook/puppeteer-view-sdk';
import { agentViewFixture, type AgentViewFixturePartial } from '@vibecook/puppeteer-view-sdk/testing';
import { bodyLayout, bodyRung, RUNG_FULL, RUNG_NAME_ONLY, WATERMARK_SIZE, WATERMARK_SMALL } from './body-layout.js';
import { baseRadius, bubbleModel, type SwarmBubbleModel } from './bubble-model.js';
import { DEFAULT_SWARM_PARAMETERS } from './swarm-parameters.js';
import { layoutCopy, type TextMeasure } from './text-layout.js';

// What a body draws at each radius the fit can give it (SWF): the copy ladder
// and the parts that follow it. The measurer is the atlas's face as a fixed
// pitch: the swarm's type is the system monospace (SF Mono, Menlo), whose
// advance is 0.6 em, plus the style's letter spacing.

const measure: TextMeasure = (text, style) =>
  [...text].length * style.size * 0.6 + [...text].length * (style.letterSpacing ?? 0) * style.size;

const NOW = Date.parse('2026-09-06T10:00:00.000Z');
const AT = NOW - 5_000;
const parameters = DEFAULT_SWARM_PARAMETERS;

function agent(partial: AgentViewFixturePartial = {}): AgentView {
  return agentViewFixture({
    id: 'a',
    createdAt: NOW,
    statusSince: AT,
    project: { name: 'puppeteer', seq: 0, branch: 'swarm' },
    detail: 'Editing tokens.css',
    colour: '#6366f1',
    provider: { id: 'imposter', label: 'Imposter' },
    model: 'Fable 5.1',
    effort: { value: 'high', intent: 'observed' },
    context: { usedPercent: 62.7 },
    ...partial,
  });
}

const cost: MonitorCost = { usd: 1.24, coverage: 'complete', burnPerHour: 0.52 * 60 };

const BODIES = {
  working: agent({ status: 'working', activity: { kind: 'tool', line: 'Editing tokens.css', since: AT }, cost }),
  idle: agent({ status: 'idle' }),
  blocked: agent({
    status: 'blocked',
    wait: { kind: 'permission', since: AT, tool: 'Bash' },
    reply: { text: 'May I run pnpm test?', at: AT, final: true },
  }),
  unread: agent({ status: 'idle', reply: { text: 'Tests pass on the branch.', at: AT, final: true } }),
  terminal: agentViewFixture({
    id: 't',
    kind: 'terminal',
    createdAt: NOW,
    statusSince: AT,
    project: { name: 'puppeteer', seq: undefined },
    detail: 'pnpm test',
    colour: '#6366f1',
    status: 'working',
    activity: { kind: 'foreground', since: AT },
    device: { id: 'mini', name: 'studio-mini', self: false },
  }),
} as const;

/** The model a body has when the fit gives it radius `radius`. */
function at(kind: keyof typeof BODIES, radius: number): SwarmBubbleModel {
  const row = BODIES[kind];
  const scale = radius / baseRadius(row, parameters);
  return bubbleModel({
    agent: row,
    parameters,
    nowMs: NOW,
    unread: kind === 'unread',
    scale,
    ...(kind === 'terminal' ? { runningSinceMs: AT - 65_000 } : {}),
  });
}

/** What a body draws, in a word per part. */
function draws(kind: keyof typeof BODIES, radius: number): string {
  const model = at(kind, radius);
  const layout = bodyLayout(model, { radius, measure });
  const parts = [
    layout.copy.lines.map((line) => line.key).join('+'),
    `mark ${model.watermark ? layout.watermark : '-'}`,
    ...(model.figures ? [layout.top === undefined ? 'no %' : '%', layout.bottom === undefined ? 'no $' : '$'] : []),
    ...(model.burn ? [layout.burn === undefined ? 'no burn' : 'burn'] : []),
  ];
  return parts.join(' · ');
}

/** The words each line keeps. */
function words(kind: keyof typeof BODIES, radius: number): string[] {
  return bodyLayout(at(kind, radius), { radius, measure }).copy.lines.map((line) => line.text);
}

describe('what a body draws at each radius band: three rungs (full → name + one line → name only)', () => {
  it('r 80: full', () => {
    expect(draws('working', 80)).toBe('branch+name+model · mark 58 · % · $ · burn');
    expect(draws('idle', 80)).toBe('name+model · mark 58');
    expect(draws('blocked', 80)).toBe('name+state+model · mark 58');
    expect(draws('terminal', 80)).toBe('name+command+elapsed+host · mark -');
    expect(words('working', 80)).toEqual(['swarm', 'puppeteer', 'fable 5.1 · high']);
  });

  it('r 60: full', () => {
    expect(draws('working', 60)).toBe('branch+name+model · mark 58 · % · $ · burn');
    expect(draws('idle', 60)).toBe('name+model · mark 58');
    expect(draws('blocked', 60)).toBe('name+state+model · mark 58');
    expect(draws('terminal', 60)).toBe('name+command+elapsed+host · mark -');
  });

  it('r 50 (the smallest base radius): still full, so a crowd at scale 1 draws what it drew', () => {
    expect(draws('working', 50)).toBe('branch+name+model · mark 58 · % · $ · burn');
    expect(draws('idle', 50)).toBe('name+model · mark 58');
    expect(draws('blocked', 50)).toBe('name+state+model · mark 58');
    expect(draws('terminal', 50)).toBe('name+command+elapsed+host · mark -');
  });

  it('r 44: the name and one line; the parts go and the mark is small', () => {
    expect(draws('working', 44)).toBe('name+model · mark 46 · no % · no $ · no burn');
    expect(draws('idle', 44)).toBe('name+model · mark 46');
    expect(draws('blocked', 44)).toBe('name+state · mark 46');
    expect(draws('terminal', 44)).toBe('name+command · mark -');
    expect(words('blocked', 44)).toEqual(['puppeteer', 'Bash']);
    expect(words('unread', 44)).toEqual(['puppeteer', 'Tests pass …']);
  });

  it('r 38: the name and one line', () => {
    expect(draws('working', 38)).toBe('name+model · mark 46 · no % · no $ · no burn');
    expect(draws('idle', 38)).toBe('name+model · mark 46');
    expect(draws('blocked', 38)).toBe('name+state · mark 46');
    expect(draws('terminal', 38)).toBe('name+command · mark -');
    expect(words('idle', 38)).toEqual(['puppet…', 'fable 5.1 · …']);
  });

  it('r 32: the name only', () => {
    expect(draws('working', 32)).toBe('name · mark 46 · no % · no $ · no burn');
    expect(draws('idle', 32)).toBe('name · mark 46');
    expect(draws('blocked', 32)).toBe('name · mark 46');
    expect(draws('terminal', 32)).toBe('name · mark -');
    expect(words('blocked', 32)).toEqual(['puppeteer']);
  });

  it('r 28 (the floor): the name only', () => {
    expect(draws('working', 28)).toBe('name · mark 46 · no % · no $ · no burn');
    expect(draws('idle', 28)).toBe('name · mark 46');
    expect(draws('blocked', 28)).toBe('name · mark 46');
    expect(draws('terminal', 28)).toBe('name · mark -');
    expect(words('idle', 28)).toEqual(['pup…']);
  });
});

describe('the rungs', () => {
  it('stand at 50 and 35, between the grid’s idle sizes 34 and 36', () => {
    expect(bodyRung(RUNG_FULL)).toBe('full');
    expect(bodyRung(49.99)).toBe('one-line');
    expect(bodyRung(RUNG_NAME_ONLY)).toBe('one-line');
    expect(bodyRung(34.99)).toBe('name');
    expect(bodyRung(50 * 0.72)).toBe('one-line');
    expect(bodyRung(50 * 0.68)).toBe('name');
  });

  it('lay a full body out exactly as the plain layout, with every part', () => {
    const model = at('working', 60);
    const layout = bodyLayout(model, { radius: 60, measure });
    expect(layout.copy).toEqual(
      layoutCopy(model.copy, { radius: 60, measure, maxWidthRatio: model.copyMaxWidthRatio }),
    );
    expect(layout.watermark).toBe(WATERMARK_SIZE);
    expect(layout.top).toBeCloseTo(-60 + 7 + 10.5 / 2, 9);
    expect(layout.bottom).toBeCloseTo(60 - 7 - 10.5 / 2, 9);
    expect(layout.burn).toBeDefined();
  });

  it('keep beside the name the state line, else the model, else a terminal’s word', () => {
    expect(words('blocked', 40)).toEqual(['puppeteer', 'Bash']);
    expect(draws('idle', 40)).toBe('name+model · mark 46');
    const empty = agentViewFixture({
      id: 'e',
      kind: 'terminal',
      createdAt: NOW,
      project: { name: 'notes', seq: undefined },
      activity: { kind: 'shell-idle' },
      device: { id: 'mini', name: 'studio-mini', self: false },
    });
    const model = bubbleModel({ agent: empty, parameters, nowMs: NOW, unread: false, scale: 0.8 });
    expect(bodyLayout(model, { radius: 40, measure }).copy.lines.map((line) => line.key)).toEqual(['name', 'sub']);
  });

  it('centre what is left: the name stands nearer the middle the fewer lines it keeps', () => {
    const name = (radius: number) =>
      bodyLayout(at('working', radius), { radius, measure }).copy.lines.find((line) => line.key === 'name')!;
    expect(Math.abs(name(32).y)).toBeLessThan(Math.abs(name(44).y));
    expect(name(32).y).toBeCloseTo(0, 9);
  });

  it('drop the one line too where it would be cut below a legible stub', () => {
    const model = at('blocked', 40);
    const loud = {
      ...model,
      copy: model.copy.map((line) => (line.key === 'state' ? { ...line, style: { ...line.style, size: 30 } } : line)),
    };
    expect(bodyLayout(loud, { radius: 40, measure }).copy.lines.map((line) => line.key)).toEqual(['name']);
  });

  it('decide at the eased radius and place at the drawn one: an arrival scales, it never changes rung', () => {
    const model = at('blocked', 36);
    const landing = bodyLayout(model, { radius: 36, scale: 0.96, measure });
    expect(landing.rung).toBe('one-line');
    expect(landing.copy.lines.map((line) => line.key)).toEqual(['name', 'state']);
    const arriving = bodyLayout(at('idle', 50), { radius: 50, scale: 0.3, measure });
    expect(arriving.rung).toBe('full');
    expect(arriving.watermark).toBe(WATERMARK_SMALL);
  });
});
