import { ACP_BRIEFING_CAPABILITIES } from '@vibefield/puppeteer-adapter-acp';

/**
 * A briefed run's MCP servers run under a leader of its own (`run-helper`): a shared leader cannot name a run, and the
 * terminal contains only the native viewer. The run's leader starts each server itself, as its own child: observed
 * against Grok Build 1.0.92 in the isolated live rig (briefing.live.test.ts, 2026-11-24). The viewer's own load of the
 * session ends them, and services/briefed-servers.ts puts them back.
 */
export const GROK_BRIEFING_CAPABILITIES = Object.freeze({
  ...ACP_BRIEFING_CAPABILITIES,
  mcpServerProcess: 'run-helper',
} as const);
