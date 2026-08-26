import type { AgentEvent } from '@vibecook/puppeteer-core';
import { boundedOpenCodeMapSet } from './wire.js';

interface ChildSessionState {
  started: boolean;
  stopped: boolean;
}

/** OpenCode child-session facts → normalized subagent lifecycle events. */
export class OpenCodeDelegationNormalizer {
  private readonly children = new Map<string, ChildSessionState>();

  constructor(private readonly maximum: number) {}

  knows(childId: string): boolean {
    return this.children.has(childId);
  }

  start(childId: string, agentType: string | undefined): AgentEvent[] {
    const existing = this.children.get(childId);
    if (existing?.started || existing?.stopped) return [];
    boundedOpenCodeMapSet(this.children, childId, { started: true, stopped: false }, this.maximum);
    return [{ type: 'delegation:subagent-started', subagentId: childId, ...(agentType ? { agentType } : {}) }];
  }

  stop(childId: string): AgentEvent[] {
    const existing = this.children.get(childId);
    if (!existing?.started || existing.stopped) {
      boundedOpenCodeMapSet(
        this.children,
        childId,
        { started: existing?.started ?? false, stopped: true },
        this.maximum,
      );
      return [];
    }
    boundedOpenCodeMapSet(this.children, childId, { started: true, stopped: true }, this.maximum);
    return [{ type: 'delegation:subagent-stopped', subagentId: childId }];
  }
}
