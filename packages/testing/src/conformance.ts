/**
 * Low-level adapter-binding conformance suite.
 *
 * Adapter-agnostic assertions that every driver's normalized binding must satisfy,
 * applied to Claude (hook + PTY) and Codex (structured app-server) through each
 * adapter's own harness. This gives the Core `AgentAdapterBinding` contract
 * executable teeth across structurally different providers.
 *
 * Deliberately tests only the UNIVERSAL contract. Adapter-specific behaviour
 * (Claude's transcript observer, Codex's structured injection determinism) is
 * covered by each adapter's own tests, not here — conformance is about what all
 * drivers share.
 */

import { describe, it, expect } from 'vitest';
import { type AgentAdapterBinding, type MonitorMetricFamily, type ObservationLevel } from '@vibecook/puppeteer-core';
import { projectAgentEvents, type TestAgentProjection } from './adapter-projection.js';

const OBSERVATION_LEVELS: ObservationLevel[] = [
  'structured',
  'native-hooks',
  'native-log',
  'workspace-process',
  'terminal-only',
];

async function waitForProjection(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

export interface AgentAdapterHarness {
  binding: AgentAdapterBinding;
  /** Reuse a projection attached by a harness that must await adapter startup. */
  projection?: TestAgentProjection;
  /** Drive one full user turn; resolves when the turn is observably complete. */
  driveTurn(prompt: string): Promise<void>;
  /** The assistant reply text `driveTurn` produces (for the lastAssistantMessage check). */
  reply: string;
  /** Reopen the same native session through the adapter's real resume path. */
  resume(): Promise<AgentAdapterHarness>;
  /** Whether this native observation surface can replay prior conversation facts. Defaults to observable. */
  resumeHistory?: 'observable' | 'identity-only';
  /** Assert that adapter/harness-owned observation, control, and process resources are gone after dispose. */
  assertNoOrphans(): Promise<void>;
}

/**
 * Register the conformance `describe` block for one adapter. Call at the top
 * level of an adapter test file: `runAgentAdapterConformance('codex', setup)`.
 * `createHarness` returns a fresh, ready-to-drive binding per assertion.
 */
export function runAgentAdapterConformance(label: string, createHarness: () => Promise<AgentAdapterHarness>): void {
  const projectionFor = (harness: AgentAdapterHarness): TestAgentProjection =>
    harness.projection ?? projectAgentEvents(harness.binding);

  describe(`Agent adapter binding conformance: ${label}`, () => {
    it('exposes non-empty session and runtime identities', async () => {
      const h = await createHarness();
      const projection = projectionFor(h);
      try {
        expect(typeof h.binding.sessionId).toBe('string');
        expect(h.binding.sessionId.length).toBeGreaterThan(0);
        expect(typeof h.binding.runtimeSessionId).toBe('string');
        expect(h.binding.runtimeSessionId.length).toBeGreaterThan(0);
      } finally {
        projection.dispose();
        await h.binding.dispose();
      }
    });

    it('reports a valid, honest observation level', async () => {
      const h = await createHarness();
      const projection = projectionFor(h);
      try {
        expect(OBSERVATION_LEVELS).toContain(h.binding.observationLevel());
      } finally {
        projection.dispose();
        await h.binding.dispose();
      }
    });

    it('transitions through a turn: running while active, ready after', async () => {
      const h = await createHarness();
      const projection = projectionFor(h);
      try {
        await h.driveTurn('do the thing');
        expect(projection.states.some(({ lifecycle }) => lifecycle === 'running')).toBe(true);
        expect(projection.state.lifecycle).toBe('ready');
        expect(projection.state.activeTurn).toBeUndefined();
        expect(projection.state.activeReasoning).toBeUndefined();
        expect(projection.state.tools.size).toBe(0);
        expect(projection.state.permissions.size).toBe(0);
      } finally {
        projection.dispose();
        await h.binding.dispose();
      }
    });

    it('records the assistant reply as lastAssistantMessage', async () => {
      const h = await createHarness();
      const projection = projectionFor(h);
      try {
        await h.driveTurn('say the reply');
        expect(projection.state.lastAssistantMessage).toBe(h.reply);
      } finally {
        projection.dispose();
        await h.binding.dispose();
      }
    });

    it('can be consumed in strictly increasing delivery order', async () => {
      const h = await createHarness();
      const projection = projectionFor(h);
      try {
        await h.driveTurn('emit some events');
        const seqs = projection.envelopes.map(({ sequence }) => sequence);
        expect(seqs.length).toBeGreaterThan(0);
        for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
      } finally {
        projection.dispose();
        await h.binding.dispose();
      }
    });

    // Resume covers two complete process lifecycles plus history replay.
    // Their bounded shutdown waits can consume most of a five-second test.
    it('resumes the same native session and remains usable', async () => {
      const original = await createHarness();
      const originalProjection = projectionFor(original);
      let resumed: AgentAdapterHarness | undefined;
      let resumedProjection: TestAgentProjection | undefined;
      try {
        await original.driveTurn('before resume');
        const nativeSessionId = original.binding.sessionId;
        await original.binding.dispose();
        await original.assertNoOrphans();

        resumed = await original.resume();
        resumedProjection = projectionFor(resumed);
        expect(resumed.binding.sessionId).toBe(nativeSessionId);
        expect(resumed.binding.runtimeSessionId.length).toBeGreaterThan(0);
        if (original.resumeHistory !== 'identity-only') {
          await waitForProjection(
            () => resumedProjection?.state.lastAssistantMessage === original.reply,
            'resumed native history',
          );
          expect(
            resumedProjection.state.lastAssistantMessage,
            'an observable-history adapter must restore native history, not merely reuse the session id',
          ).toBe(original.reply);
        }
        await resumed.driveTurn('after resume');
        expect(resumedProjection.state.lifecycle).toBe('ready');
        expect(resumedProjection.state.lastAssistantMessage).toBe(resumed.reply);
      } finally {
        resumedProjection?.dispose();
        await resumed?.binding.dispose();
        if (resumed) await resumed.assertNoOrphans();
        await original.binding.dispose();
        originalProjection.dispose();
        await original.assertNoOrphans();
      }
    }, 15_000);

    it('dispose() is idempotent and leaves no owned resources orphaned', async () => {
      const h = await createHarness();
      const projection = projectionFor(h);
      try {
        await h.binding.dispose();
        await expect(h.binding.dispose()).resolves.toBeUndefined();
        await expect(h.assertNoOrphans()).resolves.toBeUndefined();
      } finally {
        projection.dispose();
      }
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
  'delegation',
  'compaction',
  'environment',
];

export interface AgentMonitorAdapterHarness {
  binding: AgentAdapterBinding;
  /** Simulate loss of only the adapter's structured observation/control rail. */
  closeObservationRail(): void | Promise<void>;
}

/** Shared invariants for adapters publishing the evidence-backed monitor SPI. */
export function runAgentMonitorConformance(
  label: string,
  createHarness: () => Promise<AgentMonitorAdapterHarness>,
): void {
  describe(`Agent monitor conformance: ${label}`, () => {
    it('declares every family and marks initial evidence as bootstrap', async () => {
      const harness = await createHarness();
      const projection = projectAgentEvents(harness.binding);
      try {
        const batches = projection.monitorBatches;
        const capabilities = batches.flatMap((batch) => batch.capabilities ?? []);
        expect([...new Set(capabilities.map(({ family }) => family))].sort()).toEqual([...MONITOR_FAMILIES].sort());
        expect(capabilities.every(({ support }) => ['supported', 'degraded', 'unsupported'].includes(support))).toBe(
          true,
        );
        expect(batches.length).toBeGreaterThan(0);
        expect(batches.every(({ phase }) => phase === 'bootstrap')).toBe(true);
      } finally {
        projection.dispose();
        await harness.binding.dispose();
      }
    });

    it('degrades the rail without emitting process/session death', async () => {
      const harness = await createHarness();
      const projection = projectAgentEvents(harness.binding);
      try {
        await harness.closeObservationRail();
        expect(projection.envelopes.map(({ type }) => type)).not.toContain('process:exited');
        expect(projection.envelopes.map(({ type }) => type)).not.toContain('session:exited');
        expect(projection.state.lifecycle).not.toBe('exited');
        expect(projection.monitorBatches.at(-1)).toMatchObject({
          readiness: 'degraded',
          completeness: 'unavailable',
        });
      } finally {
        projection.dispose();
        await harness.binding.dispose();
      }
    });
  });
}
