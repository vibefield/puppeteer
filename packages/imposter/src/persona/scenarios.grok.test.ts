/** Raw Grok compact, subagent, hook, and ambient scenarios remain native, pre-normalization data. */
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

type ServeEntry = { before?: Array<{ op: string }>; then?: Array<{ op: string }>; result?: Record<string, unknown> };
const serve = JSON.parse(readFileSync(join(personaDirectory('grok'), 'serve.json'), 'utf8')) as Record<
  string,
  ServeEntry
>;

describe('Grok native scenarios', () => {
  it('serves only modeled requests with modeled results', () => {
    const served = Object.keys(persona.serve ?? {}).filter((method) => method !== '$server');
    expect(served).toEqual([
      'initialize',
      'session/new',
      'session/load',
      'session/prompt',
      'session/list',
      '_x.ai/auth/info',
    ]);
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

  it('advertises the 1.0.70 initialize capabilities', () => {
    expect(serve.initialize?.result).toMatchObject({
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
    });
  });

  it('preserves the captured 1.0.70 initialize, session/new, and prompt emission order', () => {
    // mcp/servers_updated follows the initialize result; setup phases precede the
    // session/new result and response_ready follows it; signals.json is written
    // after the prompt result.
    expect(serve.initialize?.before).toBeUndefined();
    expect(serve.initialize?.then?.map(({ op }) => op)).toEqual(['session.initialize']);
    expect(serve['session/new']?.before?.map(({ op }) => op)).toEqual(['session.start']);
    expect(serve['session/new']?.then?.map(({ op }) => op)).toEqual(['session.ready', 'usage.refresh']);
    expect(serve['session/prompt']?.then?.map(({ op }) => op)).toEqual(['usage.refresh']);
    expect(persona.ops['session.initialize']?.map(({ event }) => event)).toEqual(['_x.ai/mcp/servers_updated']);
    expect(persona.ops['session.start']?.map(({ event, with: payload }) => [event, payload?.phase])).toEqual([
      ['_x.ai/session/setup', 'auth'],
      ['_x.ai/session/setup', 'resolve_workspace'],
      ['_x.ai/session/setup', 'folder_trust'],
      ['_x.ai/session/setup', 'plugin_registry'],
      ['_x.ai/session/setup', 'mcp_merge'],
      ['summary.json', undefined],
    ]);
    expect(persona.ops['session.ready']?.map(({ with: payload }) => payload?.phase)).toEqual(['response_ready']);
    // Hooks and ambient updates are conditional: never part of an unconfigured session.
    const unconditional = Object.values(persona.ops)
      .flat()
      .map(
        ({ event, with: payload }) =>
          `${event}:${String((payload?.update as { sessionUpdate?: string })?.sessionUpdate)}`,
      );
    expect(
      unconditional.filter((entry) => /hook_|models\/update|settings\/update|announcements|init_progress/.test(entry)),
    ).toEqual([]);
  });

  it('offers the 1.0.70 permission options with their native ids, kinds, and order', () => {
    const request = persona.ops['permission.ask']?.find(({ event }) => event === 'session/request_permission');
    expect(request?.await).toBe(true);
    expect((request?.with as { options: unknown[] }).options).toEqual([
      expect.objectContaining({ optionId: 'always-allow', kind: 'allow_always' }),
      expect.objectContaining({ optionId: 'allow-once', kind: 'allow_once' }),
      expect.objectContaining({ optionId: 'reject-once', kind: 'reject_once' }),
      expect.objectContaining({ optionId: 'reject-always', kind: 'reject_always' }),
    ]);
  });

  it.each([
    [
      'compact-lifecycle',
      ['_x.ai/session_notification', '_x.ai/session/update', '_x.ai/session_notification', '_x.ai/session/update'],
      ['auto_compact_started', 'compaction_checkpoint', 'auto_compact_completed', 'auto_compact_completed'],
    ],
    [
      'agent-team-lifecycle',
      [
        '_x.ai/session_notification',
        '_x.ai/session_notification',
        '_x.ai/session_notification',
        '_x.ai/session/update',
        '_x.ai/session/update',
      ],
      ['subagent_spawned', 'subagent_progress', 'subagent_finished', 'subagent_spawned', 'subagent_finished'],
    ],
    [
      'configured-hooks',
      ['_x.ai/session_notification', '_x.ai/session_notification', '_x.ai/session/update'],
      ['hook_run_started', 'hook_execution', 'hook_execution'],
    ],
    [
      'remote-ambient',
      ['_x.ai/models/update', '_x.ai/settings/update', '_x.ai/announcements/update', '_x.ai/mcp/init_progress'],
      [undefined, undefined, undefined, undefined],
    ],
  ])('executes %s using only Surface-declared native rails', async (name, expectedEvents, expectedUpdates) => {
    const document = JSON.parse(readFileSync(join(personaDirectory('grok'), 'scenarios', `${name}.json`), 'utf8')) as {
      then: unknown[];
    };
    const root = mkdtempSync(join(tmpdir(), 'puppeteer-grok-scenario-'));
    roots.push(root);
    const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const runner = createScenarioRunner({
      emit: async (event, payload) => void emitted.push({ event, payload }),
      request: async () => ({}),
      transcript: createTranscriptWriter(join(root, 'unused.jsonl')),
      validate: (event, payload) => persona.validate(event, payload),
      fault: async () => undefined,
      bindings: { $sessionId: 'session-one', $cwd: root, $modelId: 'grok-imposter' },
    });

    await runner.run(scenarioSteps(document), {}, { speed: 100 });
    expect(emitted.map(({ event }) => event)).toEqual(expectedEvents);
    expect(
      emitted.map(({ payload }) => (payload.update as { sessionUpdate?: string } | undefined)?.sessionUpdate),
    ).toEqual(expectedUpdates);
  });
});
