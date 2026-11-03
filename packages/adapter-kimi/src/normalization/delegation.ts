import type { AgentEvent } from '@vibefield/puppeteer-core';
import { boundedKimiMapSet, kimiRecord, kimiString } from './types.js';

const SUBAGENT_TERMINAL_RECORDS = new Set(['subagent.completed', 'subagent.failed', 'subagent.cancelled']);

/**
 * Native subagent lifecycle → Core delegation events.
 *
 * 2.4.1 mirrors every Agent run (foreground and background) into the parent
 * journal as `subagent.spawned` → `subagent.started` → one of
 * `subagent.completed|failed|cancelled`, keyed by the child's journal id. A
 * background run additionally persists `task.started/terminated(kind: agent)`
 * carrying the same id, so both sources settle one start and one stop per run.
 * A resumed child reuses its id, so deduplication tracks whether the child's
 * current run is open rather than whether the id was ever seen: a start opens
 * a run only when none is open, and a stop closes one only when it is not
 * already closed (a stop without an observed start, e.g. a tail that began
 * mid-run, still settles the child). Other task kinds stay native.
 */
export class KimiDelegationNormalizer {
  private readonly runs = new Map<string, 'open' | 'closed'>();

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
    if (this.runs.get(subagentId) === 'open') return [];
    this.settle(subagentId, 'open');
    return [{ type: 'delegation:subagent-started', subagentId, ...(agentType ? { agentType } : {}) }];
  }

  private stop(subagentId: string): AgentEvent[] {
    if (this.runs.get(subagentId) === 'closed') return [];
    this.settle(subagentId, 'closed');
    return [{ type: 'delegation:subagent-stopped', subagentId }];
  }

  private settle(subagentId: string, state: 'open' | 'closed'): void {
    // Re-insert so the bounded map evicts by most recent transition, not first sighting.
    this.runs.delete(subagentId);
    boundedKimiMapSet(this.runs, subagentId, state);
  }
}
