import type { AgentEvent } from '@vibefield/puppeteer-core';
import type { GrokObservedEvent, GrokObservedFactory, GrokUpdate } from './types.js';

/**
 * The SessionUpdate branches of the ACP schema Grok embeds (0.11.4). Any other
 * `sessionUpdate` value, and every `_x.ai/session/update` record, is an xAI
 * extension and keeps Grok provenance instead of the generic ACP fallback.
 */
export const ACP_SESSION_UPDATE_KINDS: ReadonlySet<string> = new Set([
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
]);

/**
 * xAI extension kinds the pinned 1.0.70 census captured from the running
 * binary (verified-headless in the ground truth, on the live ACP notification
 * or the durable log). Retained records of these kinds are authoritative; a
 * kind known only from the public mirror or binary strings is retained as
 * inferred until a runtime capture promotes it.
 */
export const GROK_RUNTIME_VERIFIED_UPDATES: ReadonlySet<string> = new Set([
  'auto_compact_completed',
  'background_tasks',
  'compaction_checkpoint',
  'hook_execution',
  'hook_run_started',
  'interaction_resolved',
  'last_turn_summary',
  'model_changed',
  'pending_interaction',
  'response_completed',
  'session_summary_generated',
  'subagent_finished',
  'subagent_spawned',
  'tool_call_delta_chunk',
  'turn_completed',
]);

/** Confidence for a Grok-native record of this kind, from its Surface evidence. */
export function grokUpdateConfidence(nativeType: string): 'authoritative' | 'inferred' {
  return GROK_RUNTIME_VERIFIED_UPDATES.has(nativeType) ? 'authoritative' : 'inferred';
}

/** Preserve Grok extension identity before generic ACP can relabel it. */
export function grokExtensionEvents(method: string, params: Record<string, unknown>): AgentEvent[] {
  const update =
    params.update !== null && typeof params.update === 'object' && !Array.isArray(params.update)
      ? (params.update as Record<string, unknown>)
      : undefined;
  const nativeType = typeof update?.sessionUpdate === 'string' ? update.sessionUpdate : method;
  return [{ type: 'adapter:native-event', adapter: 'grok', nativeType }];
}

/**
 * Grok-only extensions without cross-provider semantics → retained native
 * events. Returns undefined for a standard ACP kind on the standard carrier so
 * ACP category normalization still owns it.
 */
export function normalizeGrokExtension(
  method: string,
  update: GrokUpdate,
  promptId: string | undefined,
  observed: GrokObservedFactory,
): GrokObservedEvent[] | undefined {
  const nativeType = update.sessionUpdate;
  if (!nativeType) return undefined;
  if (method !== '_x.ai/session/update' && ACP_SESSION_UPDATE_KINDS.has(nativeType)) return undefined;
  return [
    observed(
      { type: 'adapter:native-event', adapter: 'grok', nativeType },
      promptId,
      'native-log',
      grokUpdateConfidence(nativeType),
    ),
  ];
}
