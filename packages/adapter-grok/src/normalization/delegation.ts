import type { GrokObservedEvent, GrokObservedFactory, GrokUpdate } from './types.js';

/** Grok subagent extensions → normalized delegation state events. */
export function normalizeGrokDelegation(
  update: GrokUpdate,
  promptId: string | undefined,
  observed: GrokObservedFactory,
): GrokObservedEvent[] | undefined {
  if (update.sessionUpdate === 'subagent_spawned' && typeof update.subagent_id === 'string') {
    return [
      observed(
        {
          type: 'subagent.started',
          subagentId: update.subagent_id,
          ...(typeof update.subagent_type === 'string' ? { agentType: update.subagent_type } : {}),
        },
        promptId,
        'native-log',
        'inferred',
      ),
    ];
  }
  if (update.sessionUpdate === 'subagent_finished' && typeof update.subagent_id === 'string') {
    return [observed({ type: 'subagent.stopped', subagentId: update.subagent_id }, promptId, 'native-log', 'inferred')];
  }
  return undefined;
}
