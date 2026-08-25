/** Hermes persona loads against the Surface ASM and boots to ready. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createImposterSession } from '../session/session.ts';
import { loadPersona } from './load.ts';

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
});
