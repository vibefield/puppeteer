import type { AgentEvent } from '@vibecook/puppeteer-core';
import { boundedKimiSetAdd, kimiRecord, kimiString } from './types.js';

function taskId(info: Record<string, unknown> | undefined): string | undefined {
  return kimiString(info?.taskId) ?? kimiString(info?.task_id) ?? kimiString(info?.id);
}

/** Native agent-task records supply subagent lifecycle; other tasks stay native. */
export class KimiDelegationNormalizer {
  private readonly settledDelegations = new Set<string>();

  started(body: Record<string, unknown>): AgentEvent[] | undefined {
    const info = kimiRecord(body.info);
    const id = taskId(info);
    const agentId = info?.kind === 'agent' ? kimiString(info.agentId) : undefined;
    if (!id || !agentId) return undefined;
    const agentType = kimiString(info?.subagentType);
    return [{ type: 'delegation:subagent-started', subagentId: agentId, ...(agentType ? { agentType } : {}) }];
  }

  terminated(body: Record<string, unknown>): AgentEvent[] | undefined {
    const info = kimiRecord(body.info);
    const id = taskId(info);
    const agentId = info?.kind === 'agent' ? kimiString(info.agentId) : undefined;
    if (!id || !agentId) return undefined;
    if (this.settledDelegations.has(id)) return [];
    boundedKimiSetAdd(this.settledDelegations, id);
    return [{ type: 'delegation:subagent-stopped', subagentId: agentId }];
  }
}
