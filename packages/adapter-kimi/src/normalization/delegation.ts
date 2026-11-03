import type { AgentEvent } from '@vibefield/puppeteer-core';
import { boundedKimiSetAdd, kimiRecord, kimiString } from './types.js';

const SUBAGENT_TERMINAL_RECORDS = new Set(['subagent.completed', 'subagent.failed', 'subagent.cancelled']);

/**
 * Native subagent lifecycle → Core delegation events.
 *
 * 2.4.1 mirrors every Agent run (foreground and background) into the parent
 * journal as `subagent.spawned` → `subagent.started` → one of
 * `subagent.completed|failed|cancelled`, keyed by the child's journal id. A
 * background run additionally persists `task.started/terminated(kind: agent)`
 * carrying the same id, so both sources settle one start and one stop per child.
 * Other task kinds stay native.
 */
export class KimiDelegationNormalizer {
  private readonly startedSubagents = new Set<string>();
  private readonly stoppedSubagents = new Set<string>();

  started(body: Record<string, unknown>): AgentEvent[] | undefined {
    const info = kimiRecord(body.info);
    const agentId = info?.kind === 'agent' ? kimiString(info.agentId) : undefined;
    if (!agentId) return undefined;
    return this.start(agentId, kimiString(info?.subagentType));
  }

  terminated(body: Record<string, unknown>): AgentEvent[] | undefined {
    const info = kimiRecord(body.info);
    const agentId = info?.kind === 'agent' ? kimiString(info.agentId) : undefined;
    if (!agentId) return undefined;
    return this.stop(agentId);
  }

  /** `subagent.*` mirror records; `undefined` for an unknown or malformed member of the family. */
  mirrored(type: string, body: Record<string, unknown>): AgentEvent[] | undefined {
    const subagentId = kimiString(body.subagentId);
    if (!subagentId) return undefined;
    if (type === 'subagent.spawned') return this.start(subagentId, kimiString(body.subagentName));
    // `started` follows `spawned` for the same id and adds nothing portable.
    if (type === 'subagent.started') return this.start(subagentId);
    if (SUBAGENT_TERMINAL_RECORDS.has(type)) return this.stop(subagentId);
    return undefined;
  }

  private start(subagentId: string, agentType?: string): AgentEvent[] {
    if (this.startedSubagents.has(subagentId)) return [];
    boundedKimiSetAdd(this.startedSubagents, subagentId);
    return [{ type: 'delegation:subagent-started', subagentId, ...(agentType ? { agentType } : {}) }];
  }

  private stop(subagentId: string): AgentEvent[] {
    if (this.stoppedSubagents.has(subagentId)) return [];
    boundedKimiSetAdd(this.stoppedSubagents, subagentId);
    return [{ type: 'delegation:subagent-stopped', subagentId }];
  }
}
