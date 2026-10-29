import {
  validateAgentBriefing,
  type AgentBriefingCapabilities,
  type AgentRunBriefing,
} from '@vibefield/puppeteer-core';
import type { McpServer } from '@agentclientprotocol/sdk';

export const ACP_BRIEFING_CAPABILITIES = Object.freeze({
  mcpServers: true,
  allowTools: false,
  instructions: false,
  mcpServerProcess: 'external',
} as const satisfies AgentBriefingCapabilities);

/** ACP defines server configuration on both session/new and session/load, but no portable instruction/allow rule. */
export function acpBriefingServers(options: AgentRunBriefing): McpServer[] {
  const briefing = validateAgentBriefing(options, ACP_BRIEFING_CAPABILITIES, 'ACP');
  return Object.entries(briefing.mcpServers ?? {}).map(([name, server]) => ({
    name,
    command: server.command,
    args: server.args ?? [],
    env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
  }));
}
