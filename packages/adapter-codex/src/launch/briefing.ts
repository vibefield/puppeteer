import {
  AgentLaunchRefusedError,
  pickAgentBriefing,
  runToolAllowances,
  validateAgentBriefing,
  type AgentBriefingCapabilities,
  type AgentRunBriefing,
} from '@vibefield/puppeteer-core';

export const CODEX_BRIEFING_CAPABILITIES = Object.freeze({
  mcpServers: true,
  allowTools: true,
  instructions: true,
  mcpServerProcess: 'helper',
} as const satisfies AgentBriefingCapabilities);

/**
 * Thread-local overrides, never config/value/write or CLI arguments. Codex deep-merges configuration;
 * preflight refuses inherited names so a server cannot inherit another transport or tool policy.
 * RawMcpServerConfig/McpServerToolConfig at rust-v0.147.0 and 0.164.0 carry these exact fields.
 */
export function codexBriefingParams(
  options: AgentRunBriefing,
  effort?: string,
): {
  config?: Record<string, unknown>;
  developerInstructions?: string;
} {
  const briefing = validateAgentBriefing(options, CODEX_BRIEFING_CAPABILITIES, 'Codex');
  const config: Record<string, unknown> = {};
  if (effort !== undefined) config.model_reasoning_effort = effort;
  for (const [name, server] of Object.entries(briefing.mcpServers ?? {})) {
    const tools = runToolAllowances(briefing, name);
    config[`mcp_servers.${name}`] = {
      command: server.command,
      args: server.args ?? [],
      env: server.env ?? {},
      enabled: true,
      required: true,
      ...(tools.includes('*')
        ? { default_tools_approval_mode: 'approve' }
        : tools.length
          ? { tools: Object.fromEntries(tools.map((tool) => [tool, { approval_mode: 'approve' }])) }
          : {}),
    };
  }
  return {
    ...(Object.keys(config).length ? { config } : {}),
    ...(briefing.instructions === undefined ? {} : { developerInstructions: briefing.instructions }),
  };
}

/** Refuse unknown/older protocol versions and inherited-name collisions before loading the thread. */
export async function preflightCodexBriefing(
  options: AgentRunBriefing,
  initialized: unknown,
  cwd: string | undefined,
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  const briefing = pickAgentBriefing(options);
  const field = Object.keys(briefing)[0];
  if (!field) return;
  const hello = initialized as { userAgent?: unknown } | null;
  const version = typeof hello?.userAgent === 'string' ? /\/(\d+)\.(\d+)\.(\d+)\b/u.exec(hello.userAgent) : null;
  if (!version || (Number(version[1]) === 0 && Number(version[2]) < 147)) {
    throw new AgentLaunchRefusedError(
      'UNSUPPORTED_LAUNCH_FIELD',
      `This Codex app-server does not establish support for launch field: ${field} (requires 0.147.0 or newer).`,
    );
  }
  const names = Object.keys(briefing.mcpServers ?? {});
  if (!names.length) return;
  let result: unknown;
  try {
    result = await request('config/read', { includeLayers: false, ...(cwd === undefined ? {} : { cwd }) });
  } catch {
    throw new AgentLaunchRefusedError('UNSUPPORTED_LAUNCH_FIELD', 'Codex cannot verify launch field: mcpServers.');
  }
  const config = (result as { config?: { mcp_servers?: unknown } } | null)?.config;
  if (!config || typeof config !== 'object') {
    throw new AgentLaunchRefusedError('UNSUPPORTED_LAUNCH_FIELD', 'Codex cannot verify launch field: mcpServers.');
  }
  if (
    config.mcp_servers &&
    typeof config.mcp_servers === 'object' &&
    names.some((name) => Object.hasOwn(config.mcp_servers!, name))
  ) {
    throw new AgentLaunchRefusedError(
      'CONFLICTING_LAUNCH_FIELD',
      'Launch field mcpServers conflicts with a configured Codex server; use a distinct per-run server name.',
    );
  }
}
