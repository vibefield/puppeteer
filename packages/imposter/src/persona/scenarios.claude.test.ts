/**
 * The claude persona's scenario pack is executable, schema-valid data.
 *
 * This lived in `adapter-claude` while the stand-in was a per-adapter bin. The
 * scenarios are persona-owned now (docs/archive/IMPOSTER.md §3.1), and validating them
 * through `persona.validate` rather than a hand-rolled schema lookup means the
 * check runs against exactly the model the imposter would refuse them with.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTranscriptWriter } from '../session/channels/transcript.ts';
import { createScenarioRunner, scenarioSteps } from '../session/scenario.ts';
import { loadPersona, personaDirectory } from './load.ts';

const persona = loadPersona('claude');
const scenarioDir = join(personaDirectory('claude'), 'scenarios');
const temporaryDirectories: string[] = [];

type RawScenarioAction = {
  emit?: { event?: string; request?: boolean; with?: Record<string, unknown> };
  statusline?: { with?: Record<string, unknown> };
};

function actionsFor(document: unknown): RawScenarioAction[] {
  return scenarioSteps(document).map((step) => {
    const record = step as unknown as Record<string, unknown>;
    return (Object.hasOwn(record, 'do') ? record.do : record) as RawScenarioAction;
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('claude persona scenarios', () => {
  it('ships the required starter scenarios and executes every scenario against the native schema', async () => {
    const required = [
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
    const available = readdirSync(scenarioDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, ''))
      .sort();
    expect(available).toEqual(expect.arrayContaining(required));

    for (const name of available) {
      const document = JSON.parse(readFileSync(join(scenarioDir, `${name}.json`), 'utf8')) as { name: string };
      expect(document.name).toBe(name);
      const directory = mkdtempSync(join(tmpdir(), `chopsticks-${name}-`));
      temporaryDirectories.push(directory);
      const transcriptPath = join(directory, 'transcript.jsonl');
      const faults: string[] = [];
      const statuslines: Array<Record<string, unknown>> = [];
      const runner = createScenarioRunner({
        emit: async () => {},
        transcript: createTranscriptWriter(transcriptPath),
        statusline: async (payload) => {
          statuslines.push(payload);
        },
        fault: (fault) => {
          faults.push(fault.kind);
        },
        validate: (event, payload) =>
          persona.validate(event, {
            session_id: 'session',
            transcript_path: transcriptPath,
            cwd: directory,
            permission_mode: 'default',
            ...payload,
            hook_event_name: event,
          }),
        bindings: {
          $sessionTitle: 'scenario-test',
          $permissionMode: 'default',
          $sessionId: 'session',
          $transcriptPath: transcriptPath,
          $cwd: directory,
          $vendorVersion: persona.version,
          $modelId: 'claude-imposter',
          $capacityTokens: 200_000,
          $reply: 'imposter: ok',
          $claudeMdPath: join(directory, 'CLAUDE.md'),
        },
      });
      await runner.run(scenarioSteps(document), { text: 'test prompt' }, { speed: 100 });
      if (name === 'token-usage-refresh') expect(statuslines).toHaveLength(1);
      if (['flood', 'crash-mid-turn', 'channel-disconnect'].includes(name)) expect(faults).toHaveLength(1);
    }
  });

  it('keeps every curated runflow at realistic agent-workflow depth', () => {
    for (const flow of persona.runflows) {
      const document = JSON.parse(readFileSync(join(scenarioDir, `${flow.scenario}.json`), 'utf8')) as unknown;
      const actions = actionsFor(document);
      const emitted = actions.flatMap((action) => (action.emit ? [action.emit] : []));
      const tools = new Set(
        emitted.flatMap((emit) =>
          emit.event === 'PreToolUse' && typeof emit.with?.tool_name === 'string' ? [emit.with.tool_name] : [],
        ),
      );

      expect(actions.length, `${flow.id} step count`).toBeGreaterThanOrEqual(20);
      expect(actions.length, `${flow.id} step count`).toBeLessThanOrEqual(30);
      expect(tools.size, `${flow.id} tool diversity`).toBeGreaterThanOrEqual(4);
      expect(
        emitted.some((emit) => emit.event === 'TaskCreated'),
        `${flow.id} creates team tasks`,
      ).toBe(true);
      expect(
        emitted.some((emit) => emit.event === 'SubagentStart'),
        `${flow.id} delegates work`,
      ).toBe(true);
      expect(
        emitted.some((emit) => emit.event === 'TaskCompleted'),
        `${flow.id} completes team tasks`,
      ).toBe(true);
      expect(
        emitted.some((emit) => emit.event === 'SubagentStop'),
        `${flow.id} joins delegated work`,
      ).toBe(true);

      const compactStart = actions.findIndex((action) => action.emit?.event === 'PreCompact');
      const compactEnd = actions.findIndex((action) => action.emit?.event === 'PostCompact');
      const pressure = actions.findIndex((action) => {
        const context = action.statusline?.with?.context_window as Record<string, unknown> | undefined;
        return typeof context?.used_percentage === 'number' && context.used_percentage >= 90;
      });
      expect(compactStart, `${flow.id} starts compaction`).toBeGreaterThanOrEqual(0);
      expect(compactEnd, `${flow.id} completes compaction`).toBeGreaterThan(compactStart);
      expect(pressure, `${flow.id} reaches realistic context pressure`).toBeGreaterThanOrEqual(0);
      expect(pressure, `${flow.id} compacts after context pressure`).toBeLessThan(compactStart);
      expect(
        actions.slice(compactEnd + 1).some((action) => action.emit?.event === 'PreToolUse'),
        `${flow.id} verifies retained state after compaction`,
      ).toBe(true);
      expect(emitted.at(-1)?.event, `${flow.id} terminal native boundary`).toBe('Stop');
      expect(flow.steps).toBe(actions.length);
    }
  });
});
