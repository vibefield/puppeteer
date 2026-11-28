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
 *
 * The native moves (`rotate`, `fork`, `provisional`) are shared too, but not every
 * adapter follows each one: an adapter names the moves it follows
 * (`AgentAdapterConformanceOptions.moves`) and its harness gives the member of that
 * name; each named move is then held to the contract here.
 */

import { describe, it, expect } from 'vitest';
import {
  type AdapterEventCandidate,
  type AgentAdapterBinding,
  type AgentEventEnvelope,
  type MonitorMetricFamily,
  type ObservationLevel,
} from '@vibefield/puppeteer-core';
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
  /**
   * Make the agent move this run to a new native session in place (Claude's `/clear`, a conversation resumed inside
   * the TUI); resolves with the new session's id once the agent has said the move. Given when `moves` names `rotate`.
   */
  rotate?(): Promise<string>;
  /**
   * Make the agent start a session forked from this one, which this run does not observe (Claude's `/fork`);
   * resolves with the fork's id once the agent has said it. Given when `moves` names `fork`.
   */
  fork?(): Promise<string>;
  /**
   * A fresh binding whose native id is not known yet (a picker's, a lazy discovery's), with the native acts that
   * bind it. Given when `moves` names `provisional`.
   */
  provisional?(): Promise<AgentProvisionalHarness>;
}

/** A native move an adapter follows, held to the shared contract when its conformance names it. */
export type AgentAdapterMove = 'rotate' | 'fork' | 'provisional';

export interface AgentAdapterConformanceOptions {
  /** The moves this adapter follows; the harness gives the member of each name. */
  moves?: readonly AgentAdapterMove[];
}

/** A binding launched without its native id, and what binds it. */
export interface AgentProvisionalHarness {
  binding: AgentAdapterBinding;
  /**
   * Make the agent bind a session of its own (the picker's choice, the first prompt of a lazy session); resolves
   * with that session's id once the binding's `session:started` has named it.
   */
  bind(): Promise<string>;
  /**
   * Where the choice holds only after the bound session's start (Claude's picker: at the chosen session's first hook
   * of its own, since a preview starts the same way), drive that event. Absent = the predicate reads false before
   * the bound session's `session:started` is published.
   */
  hold?(): Promise<void>;
  /** Release whatever the harness owns besides the binding. */
  dispose?(): Promise<void>;
}

/**
 * Register the conformance `describe` block for one adapter. Call at the top
 * level of an adapter test file: `runAgentAdapterConformance('codex', setup)`.
 * `createHarness` returns a fresh, ready-to-drive binding per assertion.
 */
export function runAgentAdapterConformance(
  label: string,
  createHarness: () => Promise<AgentAdapterHarness>,
  options: AgentAdapterConformanceOptions = {},
): void {
  const projectionFor = (harness: AgentAdapterHarness): TestAgentProjection =>
    harness.projection ?? projectAgentEvents(harness.binding);
  const moves = new Set(options.moves ?? []);
  const member = <Name extends AgentAdapterMove>(
    harness: AgentAdapterHarness,
    name: Name,
  ): NonNullable<AgentAdapterHarness[Name]> => {
    const found = harness[name];
    if (typeof found !== 'function')
      throw new Error(`the ${label} conformance names ${name} but its harness gives none`);
    return found.bind(harness) as NonNullable<AgentAdapterHarness[Name]>;
  };
  const startsOf = (envelopes: readonly AgentEventEnvelope[], nativeSessionId: string) =>
    envelopes.filter(({ event }) => event.type === 'session:started' && event.nativeSessionId === nativeSessionId);

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

    if (moves.has('rotate')) {
      it('follows a move to a new native session: said once with rebind, and the run goes on under the new id', async () => {
        const h = await createHarness();
        const projection = projectionFor(h);
        try {
          await h.driveTurn('before the move');
          const before = h.binding.sessionId;
          const after = await member(h, 'rotate')();
          expect(after).not.toBe(before);
          await waitForProjection(() => h.binding.sessionId === after, 'the moved native session id');
          const starts = startsOf(projection.envelopes, after);
          expect(starts).toHaveLength(1);
          expect(starts[0]!.event).toMatchObject({ type: 'session:started', nativeSessionId: after, rebind: true });
          expect(starts[0]!.nativeSessionId).toBe(after);
          // a move is not a fork, and nothing after it is said under the old id
          expect(projection.envelopes.some(({ type }) => type === 'session:forked')).toBe(false);
          const moved = projection.envelopes.indexOf(starts[0]!);
          expect(projection.envelopes.slice(moved).filter(({ nativeSessionId }) => nativeSessionId === before)).toEqual(
            [],
          );
          await h.driveTurn('after the move');
          expect(projection.state.lifecycle).toBe('ready');
          expect(projection.state.lastAssistantMessage).toBe(h.reply);
          expect(projection.envelopes.at(-1)!.nativeSessionId).toBe(after);
        } finally {
          projection.dispose();
          await h.binding.dispose();
        }
      });
    }

    if (moves.has('fork')) {
      it('tells a fork once and keeps observing its own session', async () => {
        const h = await createHarness();
        const projection = projectionFor(h);
        try {
          await h.driveTurn('before the fork');
          const own = h.binding.sessionId;
          const forked = await member(h, 'fork')();
          expect(forked).not.toBe(own);
          await waitForProjection(
            () => projection.envelopes.some(({ type }) => type === 'session:forked'),
            'the fork reported',
          );
          const forks = projection.envelopes.filter(({ type }) => type === 'session:forked');
          expect(forks.map(({ event }) => event)).toEqual([
            expect.objectContaining({ type: 'session:forked', nativeSessionId: forked }),
          ]);
          // the envelope names the session this run observes, which the fork did not move
          expect(forks[0]!.nativeSessionId).toBe(own);
          expect(h.binding.sessionId).toBe(own);
          expect(startsOf(projection.envelopes, forked)).toEqual([]);
          await h.driveTurn('after the fork');
          expect(projection.state.lifecycle).toBe('ready');
          expect(projection.envelopes.at(-1)!.nativeSessionId).toBe(own);
        } finally {
          projection.dispose();
          await h.binding.dispose();
        }
      });
    }

    if (moves.has('provisional')) {
      it('says a placeholder id is provisional until a session of its own binds, and never after', async () => {
        const h = await createHarness();
        let p: AgentProvisionalHarness | undefined;
        let off: (() => void) | undefined;
        try {
          p = await member(h, 'provisional')();
          const binding = p.binding;
          expect(binding.nativeSessionProvisional, 'a provisional launch says so through its binding').toBeTypeOf(
            'function',
          );
          const provisional = (): boolean | undefined => binding.nativeSessionProvisional?.();
          const seen: Array<{ candidate: AdapterEventCandidate; provisional: boolean | undefined }> = [];
          off = binding.events.onCandidate((candidate) => seen.push({ candidate, provisional: provisional() }));
          const placeholder = binding.sessionId;
          expect(provisional()).toBe(true);

          const bound = await p.bind();
          expect(bound).not.toBe(placeholder);
          expect(binding.sessionId).toBe(bound);
          const starts = seen.filter(
            ({ candidate }) => candidate.event.type === 'session:started' && candidate.event.nativeSessionId === bound,
          );
          expect(starts.length).toBeGreaterThan(0);
          // the bound session's start is its binding, not a move of a session that had been chosen
          expect(
            starts.every(({ candidate }) => candidate.event.type === 'session:started' && !candidate.event.rebind),
          ).toBe(true);
          let from = seen.indexOf(starts[0]!);
          if (p.hold) {
            // said under the bound id while the choice may still move
            expect(starts[0]!.provisional).toBe(true);
            expect(provisional()).toBe(true);
            from = seen.length;
            await p.hold();
            expect(seen.length, 'the event that holds the choice is published').toBeGreaterThan(from);
          }
          expect(provisional()).toBe(false);
          expect(seen.slice(from).filter((entry) => entry.provisional !== false)).toEqual([]);
          expect(seen.slice(from).every(({ candidate }) => candidate.nativeSessionId === bound)).toBe(true);
          expect(binding.sessionId).toBe(bound);
        } finally {
          off?.();
          await p?.binding.dispose();
          await p?.dispose?.();
          await h.binding.dispose();
        }
      });
    }
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
