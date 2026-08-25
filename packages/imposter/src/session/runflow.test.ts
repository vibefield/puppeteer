import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScenarioRunProgressView } from '../control/protocol.ts';
import { loadPersona, personaDirectory } from '../persona/load.ts';
import { createImposterSession } from './session.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('session runflow lifecycle', () => {
  it('locks overlapping scenarios and reports step and native-sequence boundaries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'puppeteer-runflow-'));
    roots.push(root);
    const updates: ScenarioRunProgressView[] = [];
    const session = createImposterSession({
      persona: loadPersona('claude'),
      argv: [],
      env: { PUPPETEER_IMPOSTER_HOME: root },
      cwd: root,
      behavior: {},
      onScenarioRun: (update) => updates.push(update),
    });

    await session.runScenario(
      [
        { emit: { event: 'FutureHookEvent', with: { future_field: 'first' } } },
        { delay: { ms: 1 } },
        { emit: { event: 'FutureHookEvent', with: { future_field: 'second' } } },
      ],
      { mode: 'pause', scenario: 'test-flow', runflowId: 'test-flow', speed: 100 },
    );

    expect(updates[0]).toMatchObject({
      scenario: 'test-flow',
      runflowId: 'test-flow',
      status: 'paused',
      step: 0,
      steps: 3,
      fromSequence: 1,
    });
    await expect(session.runScenario([{ delay: { ms: 0 } }])).rejects.toMatchObject({
      message: expect.stringContaining('already running'),
    });

    session.scenarioControl('step');
    await waitFor(() => updates.some((update) => update.step === 1), 'first step');
    expect(session.emitted.map((entry) => entry.sequence)).toEqual([1]);
    session.scenarioControl('resume');
    await waitFor(() => updates.at(-1)?.status === 'completed', 'completion');

    expect(updates.at(-1)).toMatchObject({
      status: 'completed',
      step: 3,
      steps: 3,
      fromSequence: 1,
      throughSequence: 2,
    });
    expect(session.emitted.map((entry) => entry.sequence)).toEqual([1, 2]);
  });

  it('reports a runtime failure with the partial native sequence window', async () => {
    const root = mkdtempSync(join(tmpdir(), 'puppeteer-runflow-failure-'));
    roots.push(root);
    const updates: ScenarioRunProgressView[] = [];
    const session = createImposterSession({
      persona: loadPersona('codex'),
      argv: [],
      env: { PUPPETEER_IMPOSTER_HOME: root },
      cwd: root,
      behavior: {},
      onScenarioRun: (update) => updates.push(update),
    });
    const scenario = JSON.parse(
      readFileSync(join(personaDirectory('codex'), 'scenarios', 'permission-deny.json'), 'utf8'),
    ) as unknown;

    await expect(
      session.runScenario(scenario, {
        mode: 'play',
        scenario: 'permission-deny',
        runflowId: 'permission-deny',
        speed: 100,
      }),
    ).rejects.toThrow(/needs a server request/);

    expect(updates.at(-1)).toMatchObject({
      status: 'failed',
      step: 1,
      steps: 4,
      fromSequence: 1,
      throughSequence: 2,
      error: expect.stringContaining('needs a server request'),
    });
    expect(session.emitted.map((entry) => entry.event)).toEqual([
      'turn/started',
      'item/commandExecution/requestApproval',
    ]);
  });
});
