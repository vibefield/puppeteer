/** Rosetta-backed personas persist carriers that remain valid Surface truth. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createImposterSession, type BehaviorDocument } from '../session/session.ts';
import { loadPersona, personaDirectory } from './load.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const cases = [
  {
    vendor: 'antigravity',
    rootEnv: 'PUPPETEER_ANTIGRAVITY_DATA_ROOT',
    journal: (root: string, sessionId: string) =>
      join(root, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl'),
  },
  {
    vendor: 'copilot',
    rootEnv: 'COPILOT_HOME',
    journal: (root: string, sessionId: string) => join(root, 'session-state', sessionId, 'events.jsonl'),
  },
  {
    vendor: 'pi',
    rootEnv: 'PI_CODING_AGENT_DIR',
    journal: (root: string, sessionId: string) => join(root, 'sessions', `${sessionId}.jsonl`),
  },
] as const;

describe.each(cases)('$vendor native persona', ({ vendor, rootEnv, journal }) => {
  it('runs its organic turn and named scenario through modeled native carriers', async () => {
    const root = mkdtempSync(join(tmpdir(), `puppeteer-${vendor}-persona-`));
    roots.push(root);
    const persona = loadPersona(vendor);
    const behavior = JSON.parse(
      readFileSync(join(personaDirectory(vendor), 'behavior', 'happy-turn.json'), 'utf8'),
    ) as BehaviorDocument;
    const session = createImposterSession({
      persona,
      argv: ['--session-id', 'session-one'],
      env: { [rootEnv]: root },
      cwd: '/work/repo',
      behavior,
    });

    await session.boot();
    await session.turn('hello');
    const scenario = JSON.parse(
      readFileSync(join(personaDirectory(vendor), 'scenarios', 'happy-turn.json'), 'utf8'),
    ) as unknown;
    await session.runScenario(scenario, { stimulus: { text: 'scenario hello' }, speed: 100 });

    const records = readFileSync(journal(root, session.sessionId), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.length).toBeGreaterThan(1);
    for (const record of records) {
      expect(persona.validateRecord(String(record.type), record, persona.channelFor('native-log'))).toEqual([]);
    }
  });
});
