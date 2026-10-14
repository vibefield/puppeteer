import { describe, expect, it } from 'vitest';
import type { AgentView, MonitorCost } from '@vibefield/puppeteer-view-sdk';
import { agentViewFixture, type AgentViewFixturePartial } from '@vibefield/puppeteer-view-sdk/testing';
import { bodyLayout, WATERMARK_SIZE, WATERMARK_SMALL } from './body-layout.js';
import { baseRadius, bubbleModel, type SwarmBubbleModel } from './bubble-model.js';
import { DEFAULT_SWARM_PARAMETERS } from './swarm-parameters.js';
import type { TextMeasure } from './text-layout.js';

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

describe('what a body draws at each radius band (the ladder and the parts that follow it)', () => {
  it('r 80: everything', () => {
    expect(draws('working', 80)).toBe('branch+name+model · mark 58 · % · $ · burn');
    expect(draws('idle', 80)).toBe('name+model · mark 58');
    expect(draws('blocked', 80)).toBe('name+state+model · mark 58');
    expect(words('working', 80)).toEqual(['swarm', 'puppeteer', 'fable 5.1 · high']);
  });

  it('r 60 (today’s working size): everything, uncut', () => {
    expect(draws('working', 60)).toBe('branch+name+model · mark 58 · % · $ · burn');
    expect(draws('idle', 60)).toBe('name+model · mark 58');
    expect(draws('blocked', 60)).toBe('name+state+model · mark 58');
    expect(words('blocked', 60)).toEqual(['puppeteer', 'Bash', 'fable 5.1 · high']);
  });

  it('r 50 (today’s idle size): everything; a working name is cut', () => {
    expect(draws('working', 50)).toBe('branch+name+model · mark 58 · % · $ · burn');
    expect(words('working', 50)).toEqual(['swarm', 'puppete…', 'fable 5.1 · high']);
    expect(draws('idle', 50)).toBe('name+model · mark 58');
    expect(draws('blocked', 50)).toBe('name+state+model · mark 58');
  });

  it('r 38: the small watermark, and the burn row gives way to the total it would overlap', () => {
    expect(draws('working', 38)).toBe('branch+name+model · mark 46 · % · $ · no burn');
    expect(words('working', 38)).toEqual(['swarm', 'pupp…', 'fable 5.1 ·…']);
    expect(draws('idle', 38)).toBe('name+model · mark 46');
    expect(words('idle', 38)).toEqual(['puppet…', 'fable 5.1 · …']);
    expect(draws('blocked', 38)).toBe('name+state+model · mark 46');
  });

  it('r 28 (the floor): every agent line still reads; the figures would meet the copy and go', () => {
    // No working body is this small at today's sizes (its floor is 60 × 0.56 = 33.6); its 14 px name is cut
    // below a legible stub whatever else goes, so nothing else is taken for it.
    expect(draws('working', 28)).toBe('branch+name+model · mark 46 · no % · no $ · no burn');
    expect(draws('idle', 28)).toBe('name+model · mark 46');
    expect(words('idle', 28)).toEqual(['pup…', 'fable 5.1…']);
    expect(draws('blocked', 28)).toBe('name+state+model · mark 46');
    expect(words('blocked', 28)).toEqual(['puppe…', 'Bash', 'fable 5.…']);
  });

  it('a working body at its own floor (33.6) keeps its words and drops both figures', () => {
    expect(draws('working', 33.6)).toBe('branch+name+model · mark 46 · no % · no $ · no burn');
  });

  it('steps a terminal down in its own order: its clock goes first, its peer host last', () => {
    expect(draws('terminal', 38)).toBe('name+command+elapsed+host · mark -');
    expect(draws('terminal', 28)).toBe('name+command+host · mark -');
    expect(draws('terminal', 24)).toBe('name · mark -');
  });

  it('steps an agent down to the name alone below the floor (an arrival’s first frames)', () => {
    expect(draws('blocked', 20)).toBe('name · mark 46');
    expect(draws('unread', 20)).toBe('name · mark 46');
  });

  it('is exactly the plain layout where nothing steps down', () => {
    const model = at('working', 60);
    const layout = bodyLayout(model, { radius: 60, measure });
    expect(layout.stepped).toBe(false);
    expect(layout.watermark).toBe(WATERMARK_SIZE);
    const small = bodyLayout(at('terminal', 28), { radius: 28, measure });
    expect(small.stepped).toBe(true);
  });

  it('decides at the eased radius and places at the drawn one: an arrival scales, it never drops a line', () => {
    const model = at('blocked', 28);
    const landing = bodyLayout(model, { radius: 28, scale: 0.96, measure });
    expect(landing.copy.lines.map((line) => line.key)).toEqual(['name', 'state', 'model']);
    const landed = bodyLayout(model, { radius: 28, measure });
    expect(landing.copy.top).toBeCloseTo(landed.copy.top, 6);
    expect(landing.watermark).toBe(WATERMARK_SMALL);
  });
});
