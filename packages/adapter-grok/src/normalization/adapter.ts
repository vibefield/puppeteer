import type { AgentEvent } from '@vibecook/puppeteer-core';
import type { GrokObservedEvent, GrokObservedFactory, GrokUpdate } from './types.js';

const GROK_EXTENSION_UPDATES = new Set([
  'response_completed',
  'subagent_progress',
  'workflow_updated',
  'goal_updated',
  'auto_compact_started',
  'auto_compact_completed',
  'auto_compact_failed',
  'auto_compact_cancelled',
  'compaction_checkpoint',
  'model_changed',
  'pending_interaction',
  'interaction_resolved',
]);

const GROK_SOURCE_ONLY_UPDATES = new Set([
  'subagent_spawned',
  'subagent_progress',
  'subagent_finished',
  'workflow_updated',
  'goal_updated',
  'auto_compact_started',
  'auto_compact_completed',
  'auto_compact_failed',
  'auto_compact_cancelled',
  'compaction_checkpoint',
  'model_changed',
  'pending_interaction',
  'interaction_resolved',
]);

/** Preserve Grok extension identity before generic ACP can relabel it. */
export function grokExtensionEvents(method: string, params: Record<string, unknown>): AgentEvent[] {
  const update =
    params.update !== null && typeof params.update === 'object' && !Array.isArray(params.update)
      ? (params.update as Record<string, unknown>)
      : undefined;
  const nativeType = typeof update?.sessionUpdate === 'string' ? update.sessionUpdate : method;
  return [{ type: 'adapter:native-event', adapter: 'grok', nativeType }];
}

/** Grok-only extensions without cross-provider semantics → adapter fallback. */
export function normalizeGrokExtension(
  update: GrokUpdate,
  promptId: string | undefined,
  observed: GrokObservedFactory,
): GrokObservedEvent[] | undefined {
  const nativeType = update.sessionUpdate;
  if (!nativeType || !GROK_EXTENSION_UPDATES.has(nativeType)) return undefined;
  return [
    observed(
      { type: 'adapter:native-event', adapter: 'grok', nativeType },
      promptId,
      'native-log',
      GROK_SOURCE_ONLY_UPDATES.has(nativeType) ? 'inferred' : 'authoritative',
    ),
  ];
}
