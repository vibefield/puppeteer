import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { TurnStartedEvent } from './state/index.js';
import {
  agentEventCatalog,
  agentEventPayloadSchema,
  agentEventService,
  agentServiceEventType,
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
    expect(new Set(entries.map(([, definition]) => definition.legacyType)).size).toBe(entries.length);

    for (const [type, definition] of entries) {
      expect(type).toMatch(/^[a-z][a-z-]*:[a-z][a-z-]*$/);
      expect(type.startsWith(`${definition.category}:`)).toBe(true);
      expect(definition.schema.shape.type.safeParse(definition.legacyType).success).toBe(true);
    }
  });

  it('derives exact route, category, event, and payload types from one definition', () => {
    const event = parseAgentEvent('state:turn-started', {
      type: 'turn.started',
      turnId: 'turn-1',
      prompt: 'Refactor this',
    });

    expectTypeOf(event).toEqualTypeOf<AgentEventForType<'state:turn-started'>>();
    expectTypeOf(event).toEqualTypeOf<TurnStartedEvent>();
    expect(agentServiceEventType(event)).toBe('state:turn-started');
    expect(agentEventService(event)).toBe('state');

    expect(agentEventPayloadSchema('state:turn-started').parse({ turnId: 'turn-1', prompt: 'Refactor this' })).toEqual({
      turnId: 'turn-1',
      prompt: 'Refactor this',
    });
  });

  it('rejects malformed, misrouted, and excess canonical data', () => {
    expect(safeParseAgentEvent('context-window:updated', { type: 'context-window.updated' }).success).toBe(false);
    expect(
      safeParseAgentEvent('context-window:updated', {
        type: 'context-window.invalidated',
        reason: 'compacted',
      }).success,
    ).toBe(false);
    expect(
      safeParseAgentEvent('context-window:updated', {
        type: 'context-window.updated',
        usedTokens: 10,
        capacityTokens: 100,
        providerOnlyField: true,
      }).success,
    ).toBe(false);
    expect(() =>
      agentEventPayloadSchema('context-window:updated').parse({
        type: 'context-window.updated',
        usedTokens: 10,
        capacityTokens: 100,
      }),
    ).toThrow();
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
