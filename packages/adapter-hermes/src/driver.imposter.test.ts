import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdapterEventCandidate, AgentHost } from '@vibecook/puppeteer-core';
import { projectAgentEvents } from '@vibecook/puppeteer-testing';
import { runAgentAdapterConformance, type AgentAdapterHarness } from '@vibecook/puppeteer-testing/conformance';
import { createHermesTuiSession, type HermesTuiSession } from './driver.js';
import { createHermesImposterFixture, type HermesImposterLocation } from './test-support/imposter.js';
import type { HermesStdioClient } from './transport/stdio.js';

const REPLY = 'SURFACE_HERMES_OK';
const sessions = new Set<HermesTuiSession>();
const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...sessions].map((session) => session.dispose()));
  sessions.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function host(): AgentHost {
  return {
    async spawnTerminal() {
      return { runtimeSessionId: 'runtime-hermes-imposter' };
    },
    async automateTerminal() {
      throw new Error('Hermes structured submit must not automate the terminal');
    },
  };
}

async function createImposterHarness(location?: HermesImposterLocation, resume?: string): Promise<AgentAdapterHarness> {
  const fixture = createHermesImposterFixture(location);
  roots.add(fixture.root);
  const session = await createHermesTuiSession({
    cwd: fixture.cwd,
    host: host(),
    transport: fixture.transport,
    hermesHome: fixture.home,
    ...(resume ? { resume } : {}),
    promptConfirmationTimeoutMs: 5_000,
  });
  sessions.add(session);
  const projection = projectAgentEvents(session);
  const storedSessionId = session.storedSessionId() ?? session.sessionId;
  const persistentLocation = { root: fixture.root, cwd: fixture.cwd, home: fixture.home };

  return {
    binding: session,
    projection,
    reply: REPLY,
    resumeHistory: 'identity-only',
    async driveTurn(prompt: string) {
      const completedBefore = projection.envelopes.filter(({ event }) => event.type === 'turn:completed').length;
      const receipt = await session.services.prompt.submit({ text: prompt });
      if (receipt.status !== 'confirmed') {
        const stderr = (fixture.transport as HermesStdioClient).stderr.join('');
        throw new Error(`expected confirmed, got ${JSON.stringify(receipt)}; stderr=${stderr}`);
      }
      const deadline = Date.now() + 4_000;
      while (
        Date.now() < deadline &&
        (projection.envelopes.filter(({ event }) => event.type === 'turn:completed').length <= completedBefore ||
          projection.state.lastAssistantMessage !== REPLY)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (projection.state.lastAssistantMessage !== REPLY) {
        const stderr = (fixture.transport as HermesStdioClient).stderr.join('');
        throw new Error(
          `expected Hermes reply ${JSON.stringify(REPLY)}, got ${JSON.stringify(projection.state.lastAssistantMessage)}; stderr=${stderr}`,
        );
      }
    },
    async resume() {
      return createImposterHarness(persistentLocation, storedSessionId);
    },
    async assertNoOrphans() {
      expect((fixture.transport as HermesStdioClient).processExited()).toBe(true);
    },
  };
}

runAgentAdapterConformance('hermes-imposter', createImposterHarness);

describe('Hermes adapter against Imposter', () => {
  it('creates a session on the Imposter gateway and confirms a happy turn', async () => {
    const fixture = createHermesImposterFixture();
    roots.add(fixture.root);
    const session = await createHermesTuiSession({
      cwd: fixture.cwd,
      host: host(),
      transport: fixture.transport,
      hermesHome: fixture.home,
      promptConfirmationTimeoutMs: 5_000,
    });
    sessions.add(session);
    const projection = projectAgentEvents(session);

    expect(session.observationLevel()).toBe('structured');
    expect(projection.state.lifecycle).toBe('ready');
    expect(session.storedSessionId()).toBeTruthy();

    const observed: AdapterEventCandidate[] = [];
    const off = session.events.onCandidate((event) => observed.push(event));
    const receipt = await session.services.prompt.submit({ text: 'hello from adapter' });
    if (receipt.status !== 'confirmed') {
      const stderr = (fixture.transport as HermesStdioClient).stderr.join('');
      throw new Error(`expected confirmed, got ${JSON.stringify(receipt)}; stderr=${stderr}`);
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && projection.state.lastAssistantMessage === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    off();

    if (projection.state.lastAssistantMessage !== 'SURFACE_HERMES_OK') {
      const stderr = (fixture.transport as HermesStdioClient).stderr.join('');
      throw new Error(
        `expected Hermes reply ${JSON.stringify('SURFACE_HERMES_OK')}, got ${JSON.stringify(projection.state.lastAssistantMessage)}; stderr=${stderr}`,
      );
    }
    expect(observed.some((event) => event.event.type === 'turn:started')).toBe(true);
    expect(observed.some((event) => event.event.type === 'turn:completed')).toBe(true);
    expect(projection.state.lifecycle).toBe('ready');
    projection.dispose();
    await session.dispose();
    expect((fixture.transport as HermesStdioClient).processExited()).toBe(true);
  }, 20_000);
});
