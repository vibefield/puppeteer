import type { AgentEvent } from '@vibecook/puppeteer-core';
import { boundedKimiSetAdd, kimiRecord, kimiString } from './types.js';

function taskId(info: Record<string, unknown> | undefined): string | undefined {
  return kimiString(info?.taskId) ?? kimiString(info?.task_id) ?? kimiString(info?.id);
}

/** Kimi task journal records → task/delegation state events. */
export class KimiDelegationNormalizer {
  private readonly settledTasks = new Set<string>();

  started(body: Record<string, unknown>): AgentEvent[] | undefined {
    const info = kimiRecord(body.info);
    const id = taskId(info);
    if (!id) return undefined;
    const description = kimiString(info?.description);
    const events: AgentEvent[] = [
      { type: 'delegation:task-created', taskId: id, ...(description ? { description } : {}) },
    ];
    const agentId = info?.kind === 'agent' ? kimiString(info.agentId) : undefined;
    if (agentId) {
      const agentType = kimiString(info?.subagentType);
      events.push({ type: 'delegation:subagent-started', subagentId: agentId, ...(agentType ? { agentType } : {}) });
    }
    return events;
  }

  terminated(body: Record<string, unknown>): AgentEvent[] | undefined {
    const info = kimiRecord(body.info);
    const id = taskId(info);
    if (!id) return undefined;
    if (this.settledTasks.has(id)) return [];
    boundedKimiSetAdd(this.settledTasks, id);
    const events: AgentEvent[] = [{ type: 'delegation:task-completed', taskId: id }];
    const agentId = info?.kind === 'agent' ? kimiString(info.agentId) : undefined;
    if (agentId) events.push({ type: 'delegation:subagent-stopped', subagentId: agentId });
    return events;
  }
}
