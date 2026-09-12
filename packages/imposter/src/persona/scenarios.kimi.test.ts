/** Kimi persona scenarios and durable store remain native, pre-normalization data. */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTranscriptWriter } from '../session/channels/transcript.ts';
import { createScenarioRunner, scenarioSteps } from '../session/scenario.ts';
import { createImposterSession } from '../session/session.ts';
import { loadPersona, personaDirectory } from './load.ts';

const persona = loadPersona('kimi');
const scenarioRoot = join(personaDirectory('kimi'), 'scenarios');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Kimi native persona', () => {
  it('materializes the real nested flat-wire layout and preserves native turn-id types and sequence', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puppeteer-kimi-persona-'));
    roots.push(home);
    const session = createImposterSession({
      persona,
      argv: ['--session', 'session-one'],
      env: { KIMI_CODE_HOME: home },
      cwd: '/work/repo',
      behavior: JSON.parse(readFileSync(join(personaDirectory('kimi'), 'behavior', 'happy-turn.json'), 'utf8')) as {
        ops: Array<{ op: string; with?: Record<string, unknown> }>;
      },
    });

    await session.boot();
    await session.turn('hello');
    await session.turn('again');

    const indexRecords = readFileSync(join(home, 'session_index.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(indexRecords).toEqual([
      {
        sessionId: 'session-one',
        sessionDir: join(home, 'sessions', String(session.bindings.$workdirKey), 'session-one'),
        workDir: '/work/repo',
      },
    ]);
    expect(session.emitted.find((entry) => entry.event === 'session_index.entry')?.channel).toBe('session-index');

    const wirePath = join(
      home,
      'sessions',
      String(session.bindings.$workdirKey),
      session.sessionId,
      'agents',
      'main',
      'wire.jsonl',
    );
    const records = readFileSync(wirePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.slice(0, 13).map((record) => record.type)).toEqual([
      'metadata',
      'profile.bind',
      'permission.set_mode',
      'turn.prompt',
      'context.append_message',
      'context.append_message',
      'context.append_loop_event',
      'llm.tools_snapshot',
      'llm.request',
      'usage.record',
      'context.append_loop_event',
      'context.append_loop_event',
      'turn.ended',
    ]);
    const loop = records.find(
      (record) => (record.event as Record<string, unknown> | undefined)?.type === 'content.part',
    )!;
    expect((loop.event as Record<string, unknown>).turnId).toBe('0');
    const contentTurnIds = records
      .filter((record) => (record.event as Record<string, unknown> | undefined)?.type === 'content.part')
      .map((record) => (record.event as Record<string, unknown>).turnId);
    expect(contentTurnIds).toEqual(['0', '1']);
    expect(records.filter((record) => record.type === 'turn.ended').map((record) => record.turnId)).toEqual([0, 1]);
    expect(records.filter((record) => record.type === 'llm.request').map((record) => record.turnStep)).toEqual([
      '0.1',
      '1.1',
    ]);
  });

  it('ships executable modeled, duplicate, late, source-only, and unknown scenarios', async () => {
    const required = [
      'happy-turn',
      'tool-success',
      'tool-failure',
      'duplicate-out-of-order',
      'unknown-record',
      'late-after-end',
      'compaction-lifecycle',
    ];
    expect(
      readdirSync(scenarioRoot)
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.replace(/\.json$/, '')),
    ).toEqual(expect.arrayContaining(required));

    for (const name of required) {
      const root = mkdtempSync(join(tmpdir(), `puppeteer-kimi-${name}-`));
      roots.push(root);
      const emitted: Array<{ event: string; channel?: string | undefined }> = [];
      const runner = createScenarioRunner({
        emit: async (event, _payload, channel) => void emitted.push({ event, channel }),
        transcript: createTranscriptWriter(join(root, 'unused.jsonl')),
        validate: (event, payload) => persona.validate(event, payload),
        fault: async () => undefined,
      });
      const document = JSON.parse(readFileSync(join(scenarioRoot, `${name}.json`), 'utf8')) as unknown;
      await runner.run(scenarioSteps(document), { text: 'test prompt' }, { speed: 100 });
      expect(emitted.length, name).toBeGreaterThan(0);
      expect(
        emitted.every((entry) => entry.channel === 'wire'),
        name,
      ).toBe(true);
    }
  });
});
