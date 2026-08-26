import { otelString, type ClaudeOtelLogRecord } from './wire.js';

export type ClaudeObservedActorRole = 'child' | 'auxiliary' | 'unknown';

export interface ClaudeOtelActorAttribution {
  agentId?: string;
  agentType?: string;
  actorKey?: string;
  actorRole?: ClaudeObservedActorRole;
}

const ROOT_QUERY_SOURCES = new Set(['main', 'repl_main_thread', 'sdk']);
const AUXILIARY_QUERY_SOURCES = new Set(['compact', 'title', 'summary', 'warmup']);

function laneKey(parts: readonly string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join(':');
}

/**
 * Classify Claude requests without treating a missing native agent id as root.
 * Derived lanes are replaced when transcript sidecars provide exact identity.
 */
export function claudeOtelActor(record: ClaudeOtelLogRecord): ClaudeOtelActorAttribution {
  const agentId = otelString(record, 'agent.id') ?? otelString(record, 'agent_id');
  const agentType =
    otelString(record, 'agent.type') ?? otelString(record, 'agent.name') ?? otelString(record, 'agent_type');
  if (agentId) return { agentId, ...(agentType ? { agentType } : {}), actorRole: 'child' };

  const querySource = otelString(record, 'query_source');
  const workflowId = otelString(record, 'workflow.run_id');
  if (!workflowId && querySource && ROOT_QUERY_SOURCES.has(querySource)) return {};

  if (workflowId) {
    const label = agentType ?? querySource ?? 'unknown';
    return {
      actorKey: laneKey(['workflow', workflowId, label]),
      actorRole: 'child',
      agentType: label,
    };
  }

  if (querySource) {
    return {
      actorKey: laneKey(['query-source', querySource]),
      actorRole: AUXILIARY_QUERY_SOURCES.has(querySource) ? 'auxiliary' : 'child',
      agentType: agentType ?? querySource,
    };
  }

  if (agentType) {
    return {
      actorKey: laneKey(['agent-type', agentType]),
      actorRole: 'child',
      agentType,
    };
  }

  return { actorKey: 'unattributed', actorRole: 'unknown', agentType: 'unattributed' };
}
