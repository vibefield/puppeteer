import { describe, expect, it, vi } from 'vitest';
import { safeParseAgentEvent, type AdapterEventCandidate, type AgentHost } from '@vibecook/puppeteer-core';
import { projectAgentEvents } from '@vibecook/puppeteer-testing';
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
  it('passes model, provider, and effort as per-session creation overrides', async () => {
    const gateway = new FakeHermesGateway();
    const request = vi.spyOn(gateway, 'request');
    const session = await createHermesTuiSession({
      cwd: '/work',
      host: host(),
      transport: gateway,
      model: 'chosen-model',
      provider: 'chosen-provider',
      effort: 'high',
    });
    const projection = projectAgentEvents(session);
    try {
      expect(request).toHaveBeenCalledWith(
        'session.create',
        expect.objectContaining({ model: 'chosen-model', provider: 'chosen-provider', reasoning_effort: 'high' }),
      );
      expect(request.mock.calls.some(([method]) => method.startsWith('config.'))).toBe(false);
      expect(projection.monitorBatches.flatMap((batch) => batch.updates)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            family: 'model',
            value: { kind: 'model', providerModelId: 'chosen-model', intent: 'configured' },
          }),
          expect.objectContaining({ family: 'effort', value: { kind: 'effort', value: 'high', intent: 'configured' } }),
        ]),
      );
    } finally {
      projection.dispose();
      await session.dispose();
    }
  });

  it('attaches through an owned gateway and confirms prompt.submit via message.start', async () => {
    const gateway = new FakeHermesGateway({ reply: 'SURFACE_HERMES_OK' });
    const session = await createHermesTuiSession({
      cwd: '/work',
      host: host(),
      transport: gateway,
    });
    const projection = projectAgentEvents(session);
    try {
      expect(session.sessionId).toMatch(/^20260812_/);
      expect(session.observationLevel()).toBe('structured');
      expect(projection.state.lifecycle).toBe('ready');
      const receipt = await session.services.prompt.submit({ text: 'hello' });
      expect(receipt.status).toBe('confirmed');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(projection.state.lastAssistantMessage).toBe('SURFACE_HERMES_OK');
      expect(projection.state.lifecycle).toBe('ready');
    } finally {
      projection.dispose();
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
    const projection = projectAgentEvents(session);
    try {
      expect(projection.state.lifecycle).toBe('ready');
      expect(session.storedSessionId()).toMatch(/^20260812_/);
    } finally {
      projection.dispose();
      await session.dispose();
    }
  });

  it('publishes gateway output as catalog-routed candidates', async () => {
    const session = await createHermesTuiSession({
      cwd: '/work',
      host: host(),
      transport: new FakeHermesGateway({ reply: 'candidate reply' }),
    });
    const candidates: AdapterEventCandidate[] = [];
    expect(session.events.onCandidate).toBeTypeOf('function');
    const off = session.events.onCandidate!((candidate) => candidates.push(candidate));
    try {
      await session.services.prompt.submit({ text: 'hello' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const assistant = candidates.find(({ type }) => type === 'conversation:assistant-message');
      expect(assistant?.event.type).toBe('conversation:assistant-message');
      expect(assistant).not.toHaveProperty('sequence');
      expect(assistant && safeParseAgentEvent(assistant.type, assistant.event).success).toBe(true);
      expect(candidates.every(({ type }) => type.includes(':'))).toBe(true);
      expect(candidates.every(({ type, event }) => safeParseAgentEvent(type, event).success)).toBe(true);
    } finally {
      off();
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
      expect(await session.services.prompt.submit({ text: 'x', mode: 'paste-only' })).toMatchObject({
        status: 'rejected',
      });
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
    const projection = projectAgentEvents(session);
    const batches = projection.monitorBatches;
    const events: string[] = [];
    const offEvent = session.events.onCandidate(({ event }) => events.push(event.type));
    try {
      expect(batches.length).toBeGreaterThan(1);
      expect(batches.every(({ phase }) => phase === 'bootstrap')).toBe(true);
      expect(batches.flatMap(({ capabilities }) => capabilities ?? []).map(({ family }) => family)).toEqual(
        expect.arrayContaining(['status', 'usage', 'context', 'model', 'effort', 'mode', 'delegation']),
      );

      const receipt = await session.services.prompt.submit({ text: 'observe this' });
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

      const lifecycle = projection.state.lifecycle;
      gateway.disconnect('test rail loss');
      expect(session.observationLevel()).toBe('terminal-only');
      expect(projection.state.lifecycle).toBe(lifecycle);
      expect(events).not.toContain('session:exited');
      expect(events).not.toContain('process:exited');
      expect(batches.at(-1)).toMatchObject({ readiness: 'degraded', completeness: 'unavailable' });

      gateway.reconnect();
      expect(session.observationLevel()).toBe('structured');
      expect(batches.at(-1)).toMatchObject({ phase: 'live', readiness: 'ready', completeness: 'partial' });
    } finally {
      offEvent();
      projection.dispose();
      await session.dispose();
    }
  });
});
