/**
 * AgentSession conformance suite (DESIGN §26.2).
 *
 * Adapter-agnostic assertions that every driver's `AgentSession` must satisfy,
 * applied to Claude (hook + PTY) and Codex (structured app-server) through each
 * adapter's own harness. This is what gives the lifted core `AgentSession`
 * contract (M5 C3) teeth — and what a future Gemini/ACP adapter runs to prove
 * itself against the same bar.
 *
 * Deliberately tests only the UNIVERSAL contract. Adapter-specific behaviour
 * (Claude's transcript observer, Codex's structured injection determinism) is
 * covered by each adapter's own tests, not here — conformance is about what all
 * drivers share.
 */

import { describe, it, expect } from 'vitest';
import type { AgentSession, MonitorMetricFamily, ObservationLevel } from '@vibecook/chopsticks-core';
import type { AdapterMonitorObservationBatch } from '@vibecook/chopsticks-core/monitor-spi';

const OBSERVATION_LEVELS: ObservationLevel[] = [
  'structured',
  'native-hooks',
  'native-log',
  'workspace-process',
  'terminal-only',
];

export interface AgentSessionHarness {
  session: AgentSession;
  /** Drive one full user turn; resolves when the turn is observably complete. */
  driveTurn(prompt: string): Promise<void>;
  /** The assistant reply text `driveTurn` produces (for the lastAssistantMessage check). */
  reply: string;
  /** Reopen the same native session through the adapter's real resume path. */
  resume(): Promise<AgentSessionHarness>;
  /** Assert that adapter/harness-owned observation, control, and process resources are gone after dispose. */
  assertNoOrphans(): Promise<void>;
}

/**
 * Register the conformance `describe` block for one adapter. Call at the top
 * level of an adapter test file: `runAgentSessionConformance('codex', setup)`.
 * `createHarness` returns a fresh, ready-to-drive session per assertion.
 */
export function runAgentSessionConformance(label: string, createHarness: () => Promise<AgentSessionHarness>): void {
  describe(`AgentSession conformance: ${label}`, () => {
    it('exposes non-empty session and runtime identities', async () => {
      const h = await createHarness();
      try {
        expect(typeof h.session.sessionId).toBe('string');
        expect(h.session.sessionId.length).toBeGreaterThan(0);
        expect(typeof h.session.runtimeSessionId).toBe('string');
        expect(h.session.runtimeSessionId.length).toBeGreaterThan(0);
      } finally {
        await h.session.dispose();
      }
    });

    it('reports a valid, honest observation level', async () => {
      const h = await createHarness();
      try {
        expect(OBSERVATION_LEVELS).toContain(h.session.observationLevel());
      } finally {
        await h.session.dispose();
      }
    });

    it('transitions through a turn: running while active, ready after', async () => {
      const h = await createHarness();
      const lifecycles = new Set<string>([h.session.state().lifecycle]);
      const off = h.session.onEvent(() => lifecycles.add(h.session.state().lifecycle));
      try {
        await h.driveTurn('do the thing');
        expect(lifecycles.has('running')).toBe(true);
        expect(h.session.state().lifecycle).toBe('ready');
        expect(h.session.state().activeTurn).toBeUndefined();
        expect(h.session.state().activeReasoning).toBeUndefined();
        expect(h.session.state().tools.size).toBe(0);
        expect(h.session.state().permissions.size).toBe(0);
        expect(h.session.state().subagents.size).toBe(0);
        expect(h.session.state().tasks.size).toBe(0);
      } finally {
        off();
        await h.session.dispose();
      }
    });

    it('records the assistant reply as lastAssistantMessage', async () => {
      const h = await createHarness();
      try {
        await h.driveTurn('say the reply');
        expect(h.session.state().lastAssistantMessage).toBe(h.reply);
      } finally {
        await h.session.dispose();
      }
    });

    it('stamps observed events with strictly increasing sequence numbers', async () => {
      const h = await createHarness();
      const seqs: number[] = [];
      const off = h.session.onEvent((e) => seqs.push(e.sequence));
      try {
        await h.driveTurn('emit some events');
        expect(seqs.length).toBeGreaterThan(0);
        for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
      } finally {
        off();
        await h.session.dispose();
      }
    });

    it('resumes the same native session and remains usable', async () => {
      const original = await createHarness();
      let resumed: AgentSessionHarness | undefined;
      try {
        await original.driveTurn('before resume');
        const nativeSessionId = original.session.sessionId;
        await original.session.dispose();
        await original.assertNoOrphans();

        resumed = await original.resume();
        expect(resumed.session.sessionId).toBe(nativeSessionId);
        expect(resumed.session.runtimeSessionId.length).toBeGreaterThan(0);
        expect(
          resumed.session.state().lastAssistantMessage,
          'resume must restore observable native history, not merely reuse the session id',
        ).toBe(original.reply);
        await resumed.driveTurn('after resume');
        expect(resumed.session.state().lifecycle).toBe('ready');
        expect(resumed.session.state().lastAssistantMessage).toBe(resumed.reply);
      } finally {
        await resumed?.session.dispose();
        if (resumed) await resumed.assertNoOrphans();
        await original.session.dispose();
        await original.assertNoOrphans();
      }
    });

    it('dispose() is idempotent and leaves no owned resources orphaned', async () => {
      const h = await createHarness();
      await h.session.dispose();
      await expect(h.session.dispose()).resolves.toBeUndefined();
      await expect(h.assertNoOrphans()).resolves.toBeUndefined();
    });
  });
}

const MONITOR_FAMILIES: MonitorMetricFamily[] = [
  'status',
  'usage',
  'context',
  'model',
  'effort',
  'mode',
  'planning',
  'delegation',
  'workflow',
  'compaction',
  'environment',
];

export interface AgentMonitorSessionHarness {
  session: AgentSession;
  /** Simulate loss of only the adapter's structured observation/control rail. */
  closeObservationRail(): void | Promise<void>;
}

/** Shared invariants for adapters publishing the evidence-backed monitor SPI. */
export function runAgentMonitorConformance(
  label: string,
  createHarness: () => Promise<AgentMonitorSessionHarness>,
): void {
  describe(`Agent monitor conformance: ${label}`, () => {
    it('declares every family and marks initial evidence as bootstrap', async () => {
      const harness = await createHarness();
      const batches: AdapterMonitorObservationBatch[] = [];
      try {
        expect(harness.session.onMonitorBatch).toBeTypeOf('function');
        harness.session.onMonitorBatch?.((batch) => batches.push(batch));
        const capabilities = batches.flatMap((batch) => batch.capabilities ?? []);
        expect([...new Set(capabilities.map(({ family }) => family))].sort()).toEqual([...MONITOR_FAMILIES].sort());
        expect(capabilities.every(({ support }) => ['supported', 'degraded', 'unsupported'].includes(support))).toBe(
          true,
        );
        expect(batches.length).toBeGreaterThan(0);
        expect(batches.every(({ phase }) => phase === 'bootstrap')).toBe(true);
      } finally {
        await harness.session.dispose();
      }
    });

    it('degrades the rail without emitting process/session death', async () => {
      const harness = await createHarness();
      const events: string[] = [];
      const batches: AdapterMonitorObservationBatch[] = [];
      const lifecycle = harness.session.state().lifecycle;
      const offEvent = harness.session.onEvent(({ event }) => events.push(event.type));
      const offMonitor = harness.session.onMonitorBatch?.((batch) => batches.push(batch));
      try {
        await harness.closeObservationRail();
        expect(events).not.toContain('process.exited');
        expect(events).not.toContain('session.exited');
        expect(harness.session.state().lifecycle).toBe(lifecycle);
        expect(batches.at(-1)).toMatchObject({ readiness: 'degraded', completeness: 'unavailable' });
      } finally {
        offEvent();
        offMonitor?.();
        await harness.session.dispose();
      }
    });
  });
}
