/** Hermes persona loads against the Surface ASM and boots to ready. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createImposterSession, type BehaviorDocument } from '../session/session.ts';
import { loadPersona, personaDirectory } from './load.ts';

const persona = loadPersona('hermes');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Hermes native persona', () => {
  it('loads the Surface ASM and serves the observed tui_gateway methods', () => {
    expect(persona.vendor).toBe('hermes');
    expect(persona.version).toBe('0.20.0');
    expect(persona.serve).toBeDefined();
    expect(
      Object.keys(persona.serve ?? {})
        .filter((name) => name !== '$server')
        .sort(),
    ).toEqual(['approval.respond', 'prompt.submit', 'session.create', 'session.interrupt', 'session.resume']);
    expect(persona.serve?.['session.resume']).toMatchObject({
      then: [{ op: 'session.start' }, { op: 'session.ready' }],
    });
  });

  it('boots to ready and emits gateway.ready then session.info', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puppeteer-hermes-persona-'));
    roots.push(home);
    const session = createImposterSession({
      persona,
      argv: [],
      env: { PUPPETEER_IMPOSTER_HOME: home },
      cwd: home,
      behavior: {},
    });
    await session.boot();
    expect(session.scenarioDriver.state).toBe('ready');
    expect(session.emitted.map((entry) => entry.event)).toEqual(['gateway.ready', 'on_session_start', 'session.info']);
  });

  it('runs the default turn entirely through exact native gateway schemas', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puppeteer-hermes-behavior-'));
    roots.push(home);
    const behavior = JSON.parse(
      readFileSync(join(personaDirectory('hermes'), 'behavior', 'happy-turn.json'), 'utf8'),
    ) as BehaviorDocument;
    const session = createImposterSession({
      persona,
      argv: [],
      env: { PUPPETEER_IMPOSTER_HOME: home },
      cwd: home,
      behavior,
    });

    await session.boot();
    await session.turn('hello');

    const payload = (event: string) => session.emitted.find((entry) => entry.event === event)?.payload;
    expect(payload('thinking.delta')).toEqual({ text: '(⊙_⊙) pondering...' });
    expect(payload('message.delta')).toEqual({ text: 'SURFACE_HERMES_OK' });
    expect(payload('reasoning.available')).toEqual({ text: 'SURFACE_HERMES_OK' });
    expect(payload('message.complete')).toMatchObject({
      text: 'SURFACE_HERMES_OK',
      status: 'complete',
      usage: { input: 24, output: 6, total: 30, calls: 1 },
    });
  });
});
