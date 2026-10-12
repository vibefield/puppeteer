import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  safeParseAgentEvent,
  type AdapterEventCandidate,
  type AgentHost,
  type TerminalSpec,
} from '@vibefield/puppeteer-core';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { createOpenCodeTuiSession, type OpenCodeTuiSession } from './driver.js';
import { createOpenCodeImposterFixture } from './test-support/imposter.js';

const sessions = new Set<OpenCodeTuiSession>();
const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...sessions].map((session) => session.dispose()));
  sessions.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('OpenCode native-TUI session composition', () => {
  it('attaches the exact session and confirms REST prompts only from the matching native echo', async () => {
    const fixture = createOpenCodeImposterFixture();
    roots.add(fixture.root);
    let launch: TerminalSpec | undefined;
    const host: AgentHost = {
      async spawnTerminal(spec) {
        launch = spec;
        return { runtimeSessionId: 'runtime-opencode-test' };
      },
      async automateTerminal() {
        throw new Error('structured OpenCode prompt submission must not parse or automate terminal output');
      },
    };
    const session = await createOpenCodeTuiSession({
      cwd: fixture.cwd,
      host,
      executable: fixture.executable,
      env: fixture.env,
      promptConfirmationTimeoutMs: 2_000,
    });
    sessions.add(session);
    const projection = projectAgentEvents(session);

    expect(session.observationLevel()).toBe('structured');
    expect(projection.state.lifecycle).toBe('ready');
    expect(launch?.command).toBe(fixture.executable);
    expect(launch?.args).toEqual([
      'attach',
      session.backendOrigin(),
      '--dir',
      fixture.cwd,
      '--session',
      session.sessionId,
      '--pure',
    ]);
    expect(launch?.args).not.toContain(launch?.env?.OPENCODE_SERVER_PASSWORD);
    expect(launch?.env?.OPENCODE_SERVER_PASSWORD).toBeTruthy();

    const observed: AdapterEventCandidate[] = [];
    const candidates: AdapterEventCandidate[] = [];
    const monitor = projection.monitorBatches;
    const off = session.events.onCandidate((event) => observed.push(event));
    expect(session.events.onCandidate).toBeTypeOf('function');
    const offCandidate = session.events.onCandidate!((candidate) => candidates.push(candidate));
    expect(monitor.length).toBeGreaterThan(0);
    expect(monitor.every((batch) => batch.phase === 'bootstrap')).toBe(true);
    expect(monitor.flatMap((batch) => batch.capabilities ?? [])).toEqual(
      expect.arrayContaining([expect.objectContaining({ family: 'usage', support: 'supported' })]),
    );
    const receipt = await session.services.prompt.submit({ text: 'hello from adapter' });
    expect(receipt.status).toBe('confirmed');
    const confirmedTurnID = receipt.status === 'confirmed' ? receipt.turnId : undefined;
    expect(confirmedTurnID).toMatch(/^msg_puppeteer_/);
    await waitFor(
      () => projection.state.activeTurn === undefined && projection.state.lastAssistantMessage !== undefined,
      'turn completion',
    );
    off();

    expect(projection.state.lastAssistantMessage).toBe('imposter: ok');
    expect(observed.some((event) => event.event.type === 'turn:started' && event.promptId === confirmedTurnID)).toBe(
      true,
    );
    expect(observed.some((event) => event.event.type === 'turn:completed')).toBe(true);
    const assistant = candidates.find(({ type }) => type === 'conversation:assistant-message');
    expect(assistant).not.toHaveProperty('sequence');
    expect(assistant && safeParseAgentEvent(assistant.type, assistant.event).success).toBe(true);
    expect(candidates.every(({ type }) => type.includes(':'))).toBe(true);
    expect(candidates.every(({ type, event }) => safeParseAgentEvent(type, event).success)).toBe(true);
    expect(
      monitor.some(
        (batch) =>
          batch.phase === 'live' &&
          batch.updates.some(
            (update) =>
              update.family === 'usage' &&
              update.operation === 'upsert' &&
              update.value.canonical &&
              update.value.deltaTokens === 18,
          ),
      ),
    ).toBe(true);
    for (let index = 1; index < projection.envelopes.length; index++) {
      expect(projection.envelopes[index]!.sequence).toBeGreaterThan(projection.envelopes[index - 1]!.sequence);
    }

    const sequence = projection.state.lastSequence;
    await session.reconcile();
    expect(projection.state.lastSequence).toBe(sequence);
    offCandidate();
    projection.dispose();
  });
});
