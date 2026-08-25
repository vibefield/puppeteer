import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEventEnvelope, AgentHost } from '@vibecook/chopsticks-core';
import { createHermesTuiSession, type HermesTuiSession } from './driver.js';
import { createHermesImposterFixture } from './test-support/imposter.js';
import type { HermesStdioClient } from './transport/stdio.js';

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

    expect(session.observationLevel()).toBe('structured');
    expect(session.state().lifecycle).toBe('ready');
    expect(session.storedSessionId()).toBeTruthy();

    const observed: AgentEventEnvelope[] = [];
    const off = session.onEvent((event) => observed.push(event));
    const receipt = await session.submitPrompt({ text: 'hello from adapter' });
    if (receipt.status !== 'confirmed') {
      const stderr = (fixture.transport as HermesStdioClient).stderr.join('');
      throw new Error(`expected confirmed, got ${JSON.stringify(receipt)}; stderr=${stderr}`);
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && session.state().lastAssistantMessage === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    off();

    expect(session.state().lastAssistantMessage).toBe('SURFACE_HERMES_OK');
    expect(observed.some((event) => event.event.type === 'turn.started')).toBe(true);
    expect(observed.some((event) => event.event.type === 'turn.completed')).toBe(true);
    expect(session.state().lifecycle).toBe('ready');
  }, 20_000);
});
