import type { AgentMonitorStatus } from '@vibecook/chopsticks-core';
import type { AgentStateMessage } from '../protocol.js';

const terminalLifecycles = new Set(['exited', 'failed']);

/** Isolated one-release state projection for godviewMonitorV2=false. */
export function classifyLegacyAgentStatus(message?: AgentStateMessage): AgentMonitorStatus | undefined {
  if (!message) return 'working';
  const { state } = message;
  if (terminalLifecycles.has(state.lifecycle)) return undefined;
  if (state.permissions.length > 0) return 'blocked';
  if (
    state.lifecycle !== 'ready' ||
    state.activeTurn ||
    state.activeReasoning ||
    state.tools.length > 0 ||
    state.tasks.length > 0
  ) {
    return 'working';
  }
  return 'idle';
}

export function legacyAgentDetail(message: AgentStateMessage | undefined, status: AgentMonitorStatus): string {
  if (!message) return 'starting';
  if (status === 'blocked') {
    const permission = message.state.permissions[0];
    return permission?.tool ? `permission · ${permission.tool}` : 'permission required';
  }
  const tool = message.state.tools[0];
  if (tool) return tool.presentation?.title ?? tool.tool ?? 'using tool';
  if (message.state.activeReasoning) return 'thinking';
  if (message.state.activeTurn) return 'responding';
  return status;
}
