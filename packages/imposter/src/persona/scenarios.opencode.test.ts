import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTranscriptWriter } from '../session/channels/transcript.ts';
import { createScenarioRunner, scenarioSteps } from '../session/scenario.ts';
import { loadPersona, personaDirectory } from './load.ts';

const persona = loadPersona('opencode');
const scenarioDirectory = join(personaDirectory('opencode'), 'scenarios');
const temporaries: string[] = [];

afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

const REQUIRED = [
  'happy-turn',
  'permission-allow',
  'permission-deny',
  'question-reply',
  'question-reject',
  'resume',
  'reconnect',
  'duplicate-event',
  'late-event',
  'out-of-order',
  'failure',
  'unknown-event',
];

describe('OpenCode persona scenarios', () => {
  it('ships every planned branch as executable ASM-valid SSE traffic', async () => {
    const available = readdirSync(scenarioDirectory)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, ''))
      .sort();
    expect(available).toEqual([...REQUIRED].sort());

    for (const name of available) {
      const document = JSON.parse(readFileSync(join(scenarioDirectory, `${name}.json`), 'utf8')) as {
        name: string;
      };
      expect(document.name).toBe(name);
      const root = mkdtempSync(join(tmpdir(), `puppeteer-opencode-${name}-`));
      temporaries.push(root);
      const emitted: Array<{ event: string; payload: Record<string, unknown>; channel?: string }> = [];
      const requested: string[] = [];
      const runner = createScenarioRunner({
        emit: async (event, payload, channel) => {
          emitted.push({ event, payload, ...(channel === undefined ? {} : { channel }) });
        },
        request: async (event, payload) => {
          requested.push(event);
          emitted.push({ event, payload });
          return { accepted: true };
        },
        transcript: createTranscriptWriter(join(root, 'unused.jsonl')),
        validate: (event, payload) => persona.validate(event, payload),
        bindings: { $sessionId: 'ses_imposter', $cwd: root },
      });

      await runner.run(scenarioSteps(document), { text: 'test prompt' }, { speed: 100 });
      for (const occurrence of emitted) {
        expect(persona.validate(occurrence.event, occurrence.payload), `${name}:${occurrence.event}`).toEqual([]);
        if (persona.recordSchemaFor(occurrence.event)) {
          expect(
            persona.validateRecord(
              occurrence.event,
              { id: `evt_${crypto.randomUUID()}`, type: occurrence.event, properties: occurrence.payload },
              'sse',
            ),
            `${name}:${occurrence.event} carrier`,
          ).toEqual([]);
        }
      }

      if (name.startsWith('permission-')) expect(requested).toEqual(['permission.asked']);
      else if (name.startsWith('question-')) expect(requested).toEqual(['question.asked']);
      else expect(requested).toEqual([]);
      if (name === 'unknown-event') {
        expect(emitted).toEqual([
          { event: 'opencode.future.event', payload: { sessionID: 'ses_imposter', future: true }, channel: 'sse' },
        ]);
      }
    }
  });

  it('preserves duplicate, late, and out-of-order authoring exactly', async () => {
    const run = async (name: string): Promise<string[]> => {
      const root = mkdtempSync(join(tmpdir(), `puppeteer-opencode-order-${name}-`));
      temporaries.push(root);
      const events: string[] = [];
      const document = JSON.parse(readFileSync(join(scenarioDirectory, `${name}.json`), 'utf8')) as unknown;
      await createScenarioRunner({
        emit: async (event) => void events.push(event),
        transcript: createTranscriptWriter(join(root, 'unused.jsonl')),
        validate: (event, payload) => persona.validate(event, payload),
        bindings: { $sessionId: 'ses_imposter', $cwd: root },
      }).run(scenarioSteps(document), {}, { speed: 100 });
      return events;
    };

    expect(await run('duplicate-event')).toEqual(['session.status', 'session.status']);
    expect(await run('late-event')).toEqual(['session.idle', 'message.part.updated']);
    expect(await run('out-of-order')).toEqual(['message.part.updated', 'message.updated']);
  });

  it('exposes curated HTTP/SSE runflows with derived native facts', () => {
    expect(persona.runflows.map((flow) => flow.id)).toEqual([
      'happy-turn',
      'permission-allow',
      'question-reply',
      'reconnect',
      'out-of-order',
    ]);
    expect(persona.runflows.find((flow) => flow.id === 'permission-allow')).toMatchObject({
      channels: ['sse'],
      requiresClient: true,
      events: ['permission.asked', 'permission.replied'],
    });
    expect(persona.runflows.find((flow) => flow.id === 'reconnect')).toMatchObject({
      channels: ['sse'],
      requiresClient: false,
    });
  });
});
