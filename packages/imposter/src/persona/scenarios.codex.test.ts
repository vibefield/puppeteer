/**
 * The codex persona's scenario pack is executable, schema-valid data — the
 * same guard `scenarios.claude.test.ts` puts on the hook family.
 *
 * Codex needs one thing claude does not: approvals are SERVER REQUESTS, not
 * notifications, so the pack is only faithful if the runner can express that.
 * A scenario that emitted an approval as a notification would be scripting
 * traffic the vendor never produces, and no adapter would ever reply to it.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodexSession, type Transport } from '@vibecook/puppeteer-adapter-codex';
import { projectAgentEvents } from '@vibecook/puppeteer-testing';
import { createTranscriptWriter } from '../session/channels/transcript.ts';
import { createScenarioRunner, scenarioSteps } from '../session/scenario.ts';
import { loadPersona, personaDirectory } from './load.ts';

const persona = loadPersona('codex');
const scenarioDir = join(personaDirectory('codex'), 'scenarios');
const temporaries: string[] = [];
const THREAD = 'a0000000-0000-4000-8000-000000000001';

type RawScenarioAction = {
  emit?: { event?: string; request?: boolean; with?: Record<string, unknown> };
};

function actionsFor(document: unknown): RawScenarioAction[] {
  return scenarioSteps(document).map((step) => {
    const record = step as unknown as Record<string, unknown>;
    return (Object.hasOwn(record, 'do') ? record.do : record) as RawScenarioAction;
  });
}

async function scenarioAdapter(directory: string): Promise<{
  session: Awaited<ReturnType<typeof createCodexSession>>;
  emit(event: string, payload: Record<string, unknown>): void;
}> {
  let onMessage: ((message: unknown) => void) | undefined;
  let onClose: ((info: { code: number | null; signal: string | null }) => void) | undefined;
  const deliver = (message: unknown): void => onMessage?.(message);
  const thread = { id: THREAD, sessionId: THREAD, cwd: directory, status: { type: 'idle' } };
  const transport: Transport = {
    send(raw) {
      const message = raw as Record<string, unknown>;
      if (typeof message.method !== 'string' || message.id === undefined) return;
      switch (message.method) {
        case 'initialize':
        case 'model/list':
          deliver({ jsonrpc: '2.0', id: message.id, result: message.method === 'model/list' ? { data: [] } : {} });
          break;
        case 'thread/start':
          deliver({ jsonrpc: '2.0', id: message.id, result: { thread, cwd: directory } });
          deliver({ jsonrpc: '2.0', method: 'thread/started', params: { thread } });
          break;
        default:
          deliver({ jsonrpc: '2.0', id: message.id, result: {} });
      }
    },
    onMessage(handler) {
      onMessage = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    close() {
      onClose?.({ code: 0, signal: null });
    },
  };
  return {
    session: await createCodexSession({ cwd: directory, transport }),
    emit: (event, payload) => deliver({ jsonrpc: '2.0', method: event, params: payload }),
  };
}

async function runScenarioThroughAdapter(name: string, directory: string) {
  const document = JSON.parse(readFileSync(join(scenarioDir, `${name}.json`), 'utf8')) as { name: string };
  const adapter = await scenarioAdapter(directory);
  const projection = projectAgentEvents(adapter.session);
  const runner = createScenarioRunner({
    emit: async (event, payload) => adapter.emit(event, payload),
    transcript: createTranscriptWriter(join(directory, `${name}.jsonl`)),
    validate: (event, payload) => persona.validate(event, payload),
    bindings: {
      $threadId: THREAD,
      $threadCwd: directory,
      $cwd: directory,
      $vendorVersion: persona.version,
    },
  });
  await runner.run(scenarioSteps(document), { text: 'test prompt' }, { speed: 100 });
  return { session: adapter.session, projection };
}

afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

const REQUIRED = [
  'happy-turn',
  'permission-allow',
  'permission-deny',
  'late-after-exit',
  'duplicate-out-of-order',
  'unknown-event',
  'flood',
  'crash-mid-turn',
  'channel-disconnect',
  'token-usage-refresh',
];

describe('codex persona scenarios', () => {
  it('ships the starter set as executable, schema-valid data', async () => {
    const available = readdirSync(scenarioDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, ''))
      .sort();
    expect(available).toEqual(expect.arrayContaining(REQUIRED));

    for (const name of available) {
      const document = JSON.parse(readFileSync(join(scenarioDir, `${name}.json`), 'utf8')) as { name: string };
      expect(document.name).toBe(name);
      const directory = mkdtempSync(join(tmpdir(), `puppeteer-codex-${name}-`));
      temporaries.push(directory);

      const notified: string[] = [];
      const requested: string[] = [];
      const faults: string[] = [];
      const runner = createScenarioRunner({
        emit: async (event) => void notified.push(event),
        request: async (event) => {
          requested.push(event);
          return { decision: 'accept' };
        },
        transcript: createTranscriptWriter(join(directory, 'unused.jsonl')),
        fault: (fault) => void faults.push(fault.kind),
        validate: (event, payload) => persona.validate(event, payload),
        bindings: {
          $threadId: THREAD,
          $threadCwd: directory,
          $cwd: directory,
          $vendorVersion: persona.version,
        },
      });
      await runner.run(scenarioSteps(document), { text: 'test prompt' }, { speed: 100 });

      const expectedRequests = actionsFor(document).flatMap((action) =>
        action.emit?.request === true && typeof action.emit.event === 'string' ? [action.emit.event] : [],
      );
      expect(requested, `${name} request/notification boundary`).toEqual(expectedRequests);

      if (name.startsWith('permission-')) {
        // The decisive assertion: it went out as a REQUEST.
        expect(requested, `${name} must issue a server request`).toEqual(['item/commandExecution/requestApproval']);
      }
      if (name === 'late-after-exit') {
        expect(notified, 'late traffic must leave the persona after its close event').toEqual([
          'thread/closed',
          'item/started',
          'turn/completed',
        ]);
      }
      if (name === 'duplicate-out-of-order') {
        expect(notified, 'the adversarial order and duplicate must survive scenario execution').toEqual([
          'item/completed',
          'item/started',
          'item/completed',
        ]);
      }
      if (['flood', 'crash-mid-turn', 'channel-disconnect'].includes(name)) {
        expect(faults, `${name} must raise a fault`).toHaveLength(1);
      }
    }
  });

  it('keeps every curated runflow at realistic agent-workflow depth', () => {
    const toolItemTypes = new Set([
      'collabAgentToolCall',
      'commandExecution',
      'dynamicToolCall',
      'fileChange',
      'mcpToolCall',
      'webSearch',
    ]);

    for (const flow of persona.runflows) {
      const document = JSON.parse(readFileSync(join(scenarioDir, `${flow.scenario}.json`), 'utf8')) as unknown;
      const actions = actionsFor(document);
      const emitted = actions.flatMap((action) => (action.emit ? [action.emit] : []));
      const itemType = (emit: RawScenarioAction['emit']): string | undefined => {
        const item = emit?.with?.item as Record<string, unknown> | undefined;
        return typeof item?.type === 'string' ? item.type : undefined;
      };
      const usedToolTypes = new Set(
        emitted.flatMap((emit) => {
          const type = itemType(emit);
          return type && toolItemTypes.has(type) ? [type] : [];
        }),
      );

      expect(actions.length, `${flow.id} step count`).toBeGreaterThanOrEqual(20);
      expect(actions.length, `${flow.id} step count`).toBeLessThanOrEqual(30);
      expect(usedToolTypes.size, `${flow.id} tool diversity`).toBeGreaterThanOrEqual(4);
      expect(
        emitted.some((emit) => {
          const item = emit.with?.item as Record<string, unknown> | undefined;
          return item?.type === 'collabAgentToolCall' && item.tool === 'spawnAgent';
        }),
        `${flow.id} delegates work`,
      ).toBe(true);
      expect(
        emitted.some((emit) => {
          const item = emit.with?.item as Record<string, unknown> | undefined;
          return item?.type === 'collabAgentToolCall' && item.tool === 'wait' && item.status === 'completed';
        }),
        `${flow.id} joins delegated work`,
      ).toBe(true);

      const compactStart = emitted.findIndex(
        (emit) => emit.event === 'item/started' && itemType(emit) === 'contextCompaction',
      );
      const compactEnd = emitted.findIndex(
        (emit) => emit.event === 'item/completed' && itemType(emit) === 'contextCompaction',
      );
      const pressure = emitted.findIndex((emit) => {
        if (emit.event !== 'thread/tokenUsage/updated') return false;
        const usage = emit.with?.tokenUsage as Record<string, unknown> | undefined;
        const last = usage?.last as Record<string, unknown> | undefined;
        const totalTokens = last?.totalTokens;
        const window = usage?.modelContextWindow;
        return typeof totalTokens === 'number' && typeof window === 'number' && totalTokens / window >= 0.9;
      });
      expect(compactStart, `${flow.id} starts compaction`).toBeGreaterThanOrEqual(0);
      expect(compactEnd, `${flow.id} completes compaction`).toBeGreaterThan(compactStart);
      expect(pressure, `${flow.id} reaches realistic context pressure`).toBeGreaterThanOrEqual(0);
      expect(pressure, `${flow.id} compacts after context pressure`).toBeLessThan(compactStart);
      expect(
        emitted
          .slice(compactEnd + 1)
          .some((emit) => emit.event === 'item/started' && toolItemTypes.has(itemType(emit) ?? '')),
        `${flow.id} verifies retained state after compaction`,
      ).toBe(true);
      expect(emitted.at(-1)?.event, `${flow.id} terminal native boundary`).toBe('turn/completed');
      expect(flow.steps).toBe(actions.length);
    }
  });

  it('keeps state terminal when the late-after-exit scenario reaches the real adapter', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'puppeteer-codex-late-adapter-'));
    temporaries.push(directory);
    const { session, projection } = await runScenarioThroughAdapter('late-after-exit', directory);
    try {
      expect(projection.state.lifecycle).toBe('exited');
      expect(projection.state.tools.size).toBe(0);
      expect(projection.state.permissions.size).toBe(0);
      expect(projection.state.diagnostics.map((diagnostic) => diagnostic.code)).toContain('resource-after-exit');
    } finally {
      projection.dispose();
      await session.dispose();
    }
  });

  it('reduces duplicate and out-of-order tool events exactly once through the real adapter', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'puppeteer-codex-order-adapter-'));
    temporaries.push(directory);
    const { session, projection } = await runScenarioThroughAdapter('duplicate-out-of-order', directory);
    try {
      expect(projection.state.tools.size).toBe(0);
      expect(projection.state.counters.toolsCompleted).toBe(1);
      expect(projection.state.settledTools.size).toBe(1);
      expect(projection.state.diagnostics.map((diagnostic) => diagnostic.code)).toContain('tool-after-terminal');
    } finally {
      projection.dispose();
      await session.dispose();
    }
  });

  it('binds every scenario event to a method the ASM actually declares', () => {
    // `unknown-event` is the deliberate exception: ADR-008 retention is only
    // testable with a name the model has never seen.
    const modelled = new Set(persona.model.events.map((event) => event.event));
    const unmodelled = new Set<string>();
    for (const file of readdirSync(scenarioDir).filter((name) => name.endsWith('.json'))) {
      const document = JSON.parse(readFileSync(join(scenarioDir, file), 'utf8')) as { then?: unknown[] };
      for (const step of document.then ?? []) {
        const emit = (step as { do?: { emit?: { event?: string } } }).do?.emit;
        if (emit?.event && !modelled.has(emit.event)) unmodelled.add(`${file}:${emit.event}`);
      }
    }
    expect([...unmodelled]).toEqual(['unknown-event.json:thread/somethingTheModelHasNeverSeen']);
  });
});
