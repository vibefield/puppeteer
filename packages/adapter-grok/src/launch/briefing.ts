import { ACP_BRIEFING_CAPABILITIES } from '@vibefield/puppeteer-adapter-acp';

/** Grok's shared leader runs MCP servers; the terminal contains only its native viewer. */
export const GROK_BRIEFING_CAPABILITIES = Object.freeze({
  ...ACP_BRIEFING_CAPABILITIES,
  mcpServerProcess: 'helper',
} as const);
