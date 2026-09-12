import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { TurnStartedEvent } from './turn.js';
import {
  agentEventCatalog,
  agentEventPayloadSchema,
  agentEventCategory,
  agentEventType,
  isAgentEventType,
  parseAgentEvent,
  safeParseAgentEvent,
  type AgentEventForType,
  type AgentEventType,
} from './catalog.js';

describe('agentEventCatalog', () => {
  it('is the exhaustive source of public category:event-name routes', () => {
    const entries = Object.entries(agentEventCatalog) as Array<
      [AgentEventType, (typeof agentEventCatalog)[AgentEventType]]
    >;

    expect(entries).toHaveLength(39);
    expect(new Set(entries.map(([, definition]) => definition.eventType)).size).toBe(entries.length);

    for (const [type, definition] of entries) {
      expect(type).toMatch(/^[a-z][a-z-]*:[a-z][a-z-]*$/);
      expect(type.startsWith(`${definition.category}:`)).toBe(true);
      expect(definition.schema.shape.type.safeParse(definition.eventType).success).toBe(true);
    }
  });

  it('excludes task management from public routes and monitor batches', () => {
    for (const route of [
      'planning:updated',
      'delegation:task-created',
      'delegation:task-updated',
      'delegation:task-completed',
    ]) {
      expect(isAgentEventType(route)).toBe(false);
    }
    expect(isAgentEventType('delegation:subagent-started')).toBe(true);
    expect(isAgentEventType('mode:updated')).toBe(true);

    for (const value of [
      { kind: 'plan', planId: 'plan-1', steps: [], provisional: false },
      { kind: 'task', taskId: 'task-1', status: 'pending', provisional: false },
    ]) {
      expect(
        safeParseAgentEvent('monitor:batch', {
          type: 'monitor:batch',
          batch: {
            schemaVersion: 1,
            batchId: 'out-of-scope',
            producer: { id: 'test', epoch: 'one' },
            phase: 'live',
            observedAt: '2026-09-11T00:00:00.000Z',
            quality: 'exact',
            completeness: 'complete',
            provisional: false,
            updates: [{ family: 'planning', operation: 'upsert', key: 'current', value }],
            sourceWatermarks: [],
            evidence: [],
          },
        }).success,
      ).toBe(false);
    }
  });

  it('derives exact route, category, event, and payload types from one definition', () => {
    const event = parseAgentEvent('turn:started', {
      type: 'turn:started',
      turnId: 'turn-1',
      prompt: 'Refactor this',
    });

    expectTypeOf(event).toEqualTypeOf<AgentEventForType<'turn:started'>>();
    expectTypeOf(event).toEqualTypeOf<TurnStartedEvent>();
    expect(agentEventType(event)).toBe('turn:started');
    expect(agentEventCategory(event)).toBe('turn');

    expect(agentEventPayloadSchema('turn:started').parse({ turnId: 'turn-1', prompt: 'Refactor this' })).toEqual({
      turnId: 'turn-1',
      prompt: 'Refactor this',
    });
    expect(
      agentEventPayloadSchema('usage:tokens-used').safeParse({
        usageId: 'response-1',
        boundary: 'response',
        canonical: true,
      }).success,
    ).toBe(false);
    expect(
      agentEventPayloadSchema('usage:tokens-used').parse({
        usageId: ' response-1 ',
        boundary: 'response',
        canonical: true,
        deltaTokens: 10,
      }),
    ).toMatchObject({ usageId: 'response-1', deltaTokens: 10 });
  });

  it('rejects malformed, misrouted, and excess canonical data', () => {
    expect(safeParseAgentEvent('context-window:updated', { type: 'context-window:updated' }).success).toBe(false);
    expect(
      safeParseAgentEvent('context-window:updated', {
        type: 'context-window:invalidated',
        reason: 'compacted',
      }).success,
    ).toBe(false);
    expect(
      safeParseAgentEvent('context-window:updated', {
        type: 'context-window:updated',
        usedTokens: 10,
        capacityTokens: 100,
        providerOnlyField: true,
      }).success,
    ).toBe(false);
    expect(() =>
      agentEventPayloadSchema('context-window:updated').parse({
        type: 'context-window:updated',
        usedTokens: 10,
        capacityTokens: 100,
      }),
    ).toThrow();

    expect(
      safeParseAgentEvent('context-window:updated', {
        type: 'context-window:updated',
        usedTokens: -1,
        capacityTokens: 0,
        usedPercentage: 101,
      }).success,
    ).toBe(false);

    expect(
      safeParseAgentEvent('usage:tokens-used', {
        type: 'usage:tokens-used',
        usageId: 'empty-observation',
        boundary: 'response',
        canonical: true,
      }).success,
    ).toBe(false);
    expect(
      safeParseAgentEvent('usage:tokens-used', {
        type: 'usage:tokens-used',
        usageId: 'fractional-tokens',
        boundary: 'response',
        canonical: true,
        deltaTokens: 1.5,
      }).success,
    ).toBe(false);
    expect(
      safeParseAgentEvent('workflow:updated', {
        type: 'workflow:updated',
        workflowId: '   ',
        active: true,
      }).success,
    ).toBe(false);
    expect(
      safeParseAgentEvent('workflow:updated', {
        type: 'workflow:updated',
        workflowId: 'workflow-1',
        active: true,
        members: [
          { agentId: 'worker-1', state: 'active' },
          { agentId: 'worker-1', state: 'completed' },
        ],
      }).success,
    ).toBe(false);
    expect(
      safeParseAgentEvent('interaction:question-requested', {
        type: 'interaction:question-requested',
        requestId: 'question-1',
        questions: [{ prompt: '   ' }],
      }).success,
    ).toBe(false);

    expect(
      safeParseAgentEvent('monitor:batch', {
        type: 'monitor:batch',
        batch: {
          schemaVersion: 1,
          batchId: 'bad-value',
          producer: { id: 'test', epoch: 'one' },
          phase: 'live',
          observedAt: '2026-08-25T00:00:00.000Z',
          quality: 'exact',
          completeness: 'complete',
          provisional: false,
          updates: [{ family: 'compaction', operation: 'upsert', key: 'current', value: null }],
          sourceWatermarks: [],
          evidence: [],
        },
      }).success,
    ).toBe(false);

    const monitorBatch = {
      type: 'monitor:batch',
      batch: {
        schemaVersion: 1,
        batchId: 'batch-1',
        producer: { id: 'test', epoch: 'one' },
        phase: 'live',
        observedAt: '2026-08-25T00:00:00.000Z',
        quality: 'exact',
        completeness: 'complete',
        provisional: false,
        updates: [],
        sourceWatermarks: [],
        evidence: [{ namespace: 'transcript', id: 'row-1', cursorStart: 20, cursorEnd: 10 }],
      },
    };
    expect(safeParseAgentEvent('monitor:batch', monitorBatch).success).toBe(false);
    expect(
      safeParseAgentEvent('monitor:batch', {
        ...monitorBatch,
        batch: {
          ...monitorBatch.batch,
          evidence: [],
          updates: [
            {
              family: 'usage',
              operation: 'upsert',
              key: 'usage-1',
              value: { kind: 'usage', usageId: 'usage-1', boundary: 'response', canonical: true },
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it('keeps the Agent API reference synchronized with the canonical catalog', () => {
    const html = readFileSync(fileURLToPath(new URL('../../../../docs/agent-api.html', import.meta.url)), 'utf8');
    const documentedRoutes = [...html.matchAll(/<span class="route">\s*([a-z][a-z-]*:[a-z][a-z-]*)\s*<\/span\s*>/g)]
      .map((match) => match[1]!)
      .sort();
    const catalogRoutes = Object.keys(agentEventCatalog).sort();

    expect(documentedRoutes).toEqual(catalogRoutes);
  });
});
