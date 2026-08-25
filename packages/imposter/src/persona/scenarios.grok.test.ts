/** Raw Grok compact and subagent scenarios remain native, pre-normalization data. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTranscriptWriter } from '../session/channels/transcript.ts';
import { createScenarioRunner, scenarioSteps } from '../session/scenario.ts';
import { loadPersona, personaDirectory } from './load.ts';

const persona = loadPersona('grok');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Grok native scenarios', () => {
  it('serves only modeled requests with modeled results', () => {
    const served = Object.keys(persona.serve ?? {}).filter((method) => method !== '$server');
    expect(served).toEqual(['initialize', 'session/new', 'session/load', 'session/prompt']);
    for (const method of served) {
      expect(persona.model.events.find((event) => event.event === method)).toMatchObject({
        direction: 'client-to-agent',
        transport: 'jsonrpc-request',
      });
      expect(persona.resultSchemaFor(method), method).toBeDefined();
    }
    expect(persona.model.events.find((event) => event.event === 'session/cancel')).toMatchObject({
      transport: 'jsonrpc-notification',
    });
  });

  it('preserves the captured initialize and session-start emission order', () => {
    const serve = JSON.parse(readFileSync(join(personaDirectory('grok'), 'serve.json'), 'utf8')) as Record<
      string,
      { before?: Array<{ op: string }> }
    >;

    expect(serve.initialize?.before?.map(({ op }) => op)).toEqual(['session.initialize']);
    expect(serve['session/new']?.before?.map(({ op }) => op)).toEqual([
      'session.start',
      'session.ready',
      'usage.refresh',
    ]);
    expect(persona.ops['session.initialize']?.map(({ event }) => event)).toEqual([
      '_x.ai/mcp/servers_updated',
      '_x.ai/models/update',
      '_x.ai/settings/update',
      '_x.ai/announcements/update',
      '_x.ai/mcp/init_progress',
    ]);
    expect(persona.ops['session.ready']).toBeUndefined();
    expect(persona.ops['session.start']?.map(({ event }) => event)).toEqual([
      'session/update',
      '_x.ai/session_notification',
      '_x.ai/session/update',
      'summary.json',
    ]);
  });

  it.each([
    ['compact-lifecycle', ['auto_compact_started', 'compaction_checkpoint', 'auto_compact_completed']],
    ['agent-team-lifecycle', ['subagent_spawned', 'subagent_progress', 'subagent_finished']],
  ])('executes %s using only Surface-declared native rails', async (name, expectedUpdates) => {
    const document = JSON.parse(readFileSync(join(personaDirectory('grok'), 'scenarios', `${name}.json`), 'utf8')) as {
      then: unknown[];
    };
    const root = mkdtempSync(join(tmpdir(), 'chopsticks-grok-scenario-'));
    roots.push(root);
    const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const runner = createScenarioRunner({
      emit: async (event, payload) => void emitted.push({ event, payload }),
      request: async () => ({}),
      transcript: createTranscriptWriter(join(root, 'unused.jsonl')),
      validate: (event, payload) => persona.validate(event, payload),
      fault: async () => undefined,
      bindings: { $sessionId: 'session-one', $cwd: root },
    });

    await runner.run(scenarioSteps(document), {}, { speed: 100 });
    expect(emitted.map(({ event }) => event)).toEqual(
      name === 'compact-lifecycle'
        ? ['_x.ai/session_notification', '_x.ai/session/update', '_x.ai/session_notification']
        : ['_x.ai/session_notification', '_x.ai/session_notification', '_x.ai/session_notification'],
    );
    expect(emitted.map(({ payload }) => (payload.update as { sessionUpdate: string }).sessionUpdate)).toEqual(
      expectedUpdates,
    );
  });
});
