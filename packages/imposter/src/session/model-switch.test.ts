/**
 * A scenario that switches the model leaves the session on it. Claude Code 2.1.308 keeps reporting
 * the switched model on every later status-line refresh; an Imposter that fell back to its launch
 * model would show an observer the model flipping back after the scenario ends.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPersona, personaDirectory } from '../persona/load.ts';
import { createImposterSession, type BehaviorDocument } from './session.ts';

const temporaries = new Set<string>();

afterEach(() => {
  for (const path of temporaries) rmSync(path, { recursive: true, force: true });
  temporaries.clear();
});

const persona = loadPersona('claude');
const document = (kind: 'behavior' | 'scenarios', name: string): unknown =>
  JSON.parse(readFileSync(join(personaDirectory('claude'), kind, `${name}.json`), 'utf8'));

describe('claude model switch', () => {
  it('serves the switched model on every later status line, and to later templates', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puppeteer-model-switch-'));
    temporaries.add(home);
    const session = createImposterSession({
      persona,
      argv: ['--model', 'claude-sonnet-4-5-20250929'],
      env: { PUPPETEER_IMPOSTER_HOME: home },
      cwd: home,
      behavior: document('behavior', 'happy-turn') as BehaviorDocument,
    });
    await session.boot();
    expect(session.statusPayload().model).toMatchObject({ id: 'claude-sonnet-4-5-20250929' });

    await session.runScenario(document('scenarios', 'model-switch'), { speed: 100, stimulus: { text: '/model opus' } });
    const switched = session.emitted.find((entry) => entry.event === 'PostModelSwitch');
    expect(switched?.payload).toMatchObject({ from_model: 'claude-sonnet-4-5-20250929', to_model: 'claude-opus-5-5' });

    // An organic turn afterwards refreshes the status line from the session's own state.
    await session.turn('and now?');
    expect(session.statusPayload().model).toEqual({ id: 'claude-opus-5-5', display_name: 'Opus 5.5' });
    expect(session.bindings.$modelId).toBe('claude-opus-5-5');
  });
});
