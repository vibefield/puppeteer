import { ACP_BRIEFING_CAPABILITIES } from '@vibefield/puppeteer-adapter-acp';

/**
 * A briefed run's MCP servers run under a leader of its own (`run-helper`): a shared leader cannot name a run, and the
 * terminal contains only the native viewer. That the leader spawns each session's MCP children itself is this adapter's
 * reading, carried from its earlier comment; it has NOT been observed against a live Grok.
 */
export const GROK_BRIEFING_CAPABILITIES = Object.freeze({
  ...ACP_BRIEFING_CAPABILITIES,
  mcpServerProcess: 'run-helper',
} as const);
