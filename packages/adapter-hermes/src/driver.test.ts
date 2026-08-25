import { describe, expect, it } from 'vitest';
import type { AgentHost } from '@vibecook/chopsticks-core';
import type { AdapterMonitorObservationBatch } from '@vibecook/chopsticks-core/monitor-spi';
import { createHermesTuiSession } from './driver.js';
import { FakeHermesGateway } from './test-support/fake-gateway.js';

function host(): AgentHost {
  return {
    async spawnTerminal() {
      return { runtimeSessionId: 'term-1' };
    },
    async automateTerminal() {
      return { accepted: true };
    },
  };
}

describe('Hermes TUI session driver', () => {
  it('attaches through an owned gateway and confirms prompt.submit via message.start', async () => {
    const gateway = new FakeHermesGateway({ reply: 'SURFACE_HERMES_OK' });
    const session = await createHermesTuiSession({
      cwd: '/work',
      host: host(),
      transport: gateway,
    });
    try {
      expect(session.sessionId).toMatch(/^20260812_/);
      expect(session.observationLevel()).toBe('structured');
      expect(session.state().lifecycle).toBe('ready');
      const receipt = await session.submitPrompt({ text: 'hello' });
      expect(receipt.status).toBe('confirmed');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(session.state().lastAssistantMessage).toBe('SURFACE_HERMES_OK');
      expect(session.state().lifecycle).toBe('ready');
    } finally {
      await session.dispose();
      await session.dispose();
      expect(gateway.closed).toBe(true);
    }
  });

  it('reaches ready from session.create even when session.info never arrives', async () => {
    const session = await createHermesTuiSession({
      cwd: '/work',
      host: host(),
      transport: new FakeHermesGateway({ announceSession: false }),
    });
    try {
      expect(session.state().lifecycle).toBe('ready');
      expect(session.storedSessionId()).toMatch(/^20260812_/);
    } finally {
      await session.dispose();
    }
  });

  it('rejects paste-only and does not answer approvals', async () => {
    const session = await createHermesTuiSession({
      cwd: '/work',
      host: host(),
      transport: new FakeHermesGateway(),
    });
    try {
      expect(await session.submitPrompt({ text: 'x', mode: 'paste-only' })).toMatchObject({ status: 'rejected' });
      expect(session).not.toHaveProperty('replyPermission');
    } finally {
      await session.dispose();
    }
  });

  it('publishes bootstrap and live monitor evidence and degrades only the side rail on disconnect', async () => {
    const gateway = new FakeHermesGateway();
    const session = await createHermesTuiSession({
      cwd: '/work',
      host: host(),
      transport: gateway,
    });
    const batches: AdapterMonitorObservationBatch[] = [];
    const events: string[] = [];
    const offMonitor = session.onMonitorBatch?.((batch) => batches.push(batch));
    const offEvent = session.onEvent(({ event }) => events.push(event.type));
    try {
      expect(batches.length).toBeGreaterThan(1);
      expect(batches.every(({ phase }) => phase === 'bootstrap')).toBe(true);
      expect(batches.flatMap(({ capabilities }) => capabilities ?? []).map(({ family }) => family)).toEqual(
        expect.arrayContaining(['status', 'usage', 'context', 'model', 'effort', 'mode', 'planning', 'delegation']),
      );

      const receipt = await session.submitPrompt({ text: 'observe this' });
      expect(receipt.status).toBe('confirmed');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        batches
          .filter(({ phase }) => phase === 'live')
          .flatMap(({ updates }) => updates)
          .find(
            (update) =>
              update.family === 'usage' && update.operation === 'upsert' && update.value.cumulativeTokens === 30,
          ),
      ).toBeDefined();

      const lifecycle = session.state().lifecycle;
      gateway.disconnect('test rail loss');
      expect(session.observationLevel()).toBe('terminal-only');
      expect(session.state().lifecycle).toBe(lifecycle);
      expect(events).not.toContain('session.exited');
      expect(events).not.toContain('process.exited');
      expect(batches.at(-1)).toMatchObject({ readiness: 'degraded', completeness: 'unavailable' });

      gateway.reconnect();
      expect(session.observationLevel()).toBe('structured');
      expect(batches.at(-1)).toMatchObject({ phase: 'live', readiness: 'ready', completeness: 'partial' });
    } finally {
      offMonitor?.();
      offEvent();
      await session.dispose();
    }
  });
});
