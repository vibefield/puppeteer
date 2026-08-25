import type { SessionActivity } from '@vibecook/ghosttea-protocol';
import type { AgentMonitorStatus } from '@vibecook/puppeteer-core';
import type { AgentSessionInfo } from '../protocol.js';
import { folderName } from './folder-name.js';

/**
 * What a session is doing, derived only from reduced runtime state — never from
 * terminal text (DESIGN ADR-003/-005). How a status is then drawn is each
 * monitor view's own business.
 */
export type AgentVisualStatus = AgentMonitorStatus;

export function classifyTerminalStatus(
  activity: Pick<SessionActivity, 'kind'> | undefined,
): Exclude<AgentVisualStatus, 'blocked'> {
  return activity?.kind === 'foreground-job' ? 'working' : 'idle';
}

export function projectLabel(info: AgentSessionInfo, currentCwd?: string): string {
  const path = currentCwd || info.workspace.sourcePath || info.workspace.root || info.session.cwd || '';
  return folderName(path, info.agent);
}

export function providerLabel(agent: AgentSessionInfo['agent']): string {
  switch (agent) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'grok':
      return 'Grok';
    case 'hermes':
      return 'Hermes';
    case 'kimi':
      return 'Kimi';
    case 'opencode':
      return 'OpenCode';
    case 'acp':
      return 'ACP';
  }
}

export function agentColor(id: string): string {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `hsl(${Math.abs(hash) % 360} 62% 44%)`;
}
