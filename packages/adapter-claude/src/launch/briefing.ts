import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  validateAgentBriefing,
  type AgentBriefingCapabilities,
  type AgentRunBriefing,
} from '@vibefield/puppeteer-core';

export const CLAUDE_BRIEFING_CAPABILITIES = Object.freeze({
  mcpServers: true,
  allowTools: true,
  instructions: true,
  mcpServerProcess: 'terminal',
} as const satisfies AgentBriefingCapabilities);

/** Optional launch-recipe probes, independent of the versioned observation promotion.
 * These spellings are in the pinned 2.1.308 help (append-file as `[-file]`); the live briefing test exercises them.
 */
export const CLAUDE_BRIEFING_FLAGS = {
  mcpServers: '--mcp-config',
  allowTools: '--allowedTools',
  appendSystemPromptFile: '--append-system-prompt-file',
  systemPromptSnapshot: '--system-prompt-snapshot',
} as const;

/** Session-owned files keep the command line bounded; environment values never enter a file or argv. */
export async function prepareClaudeBriefing(
  options: AgentRunBriefing,
  directory: string,
  filesToCleanup: string[],
): Promise<{ args: string[]; env: Record<string, string> }> {
  const briefing = validateAgentBriefing(options, CLAUDE_BRIEFING_CAPABILITIES, 'Claude');
  const args: string[] = [];
  const env: Record<string, string> = {};
  const id = randomUUID().replaceAll('-', '');
  if (briefing.mcpServers !== undefined) {
    const servers = Object.fromEntries(
      Object.entries(briefing.mcpServers).map(([name, server], index) => {
        const variables = Object.fromEntries(
          Object.entries(server.env ?? {}).map(([key, value], variable) => {
            const name = `PUPPETEER_MCP_${id}_${index}_${variable}`;
            env[name] = value;
            return [key, '${' + name + '}'];
          }),
        );
        return [name, { command: server.command, args: server.args ?? [], env: variables }];
      }),
    );
    const path = join(directory, `${id}.mcp.json`);
    await writeOwnedFile(path, JSON.stringify({ mcpServers: servers }), filesToCleanup);
    args.push(CLAUDE_BRIEFING_FLAGS.mcpServers, path);
  }
  if (briefing.allowTools?.length) {
    const tools = briefing.allowTools.map((tool) => {
      const slash = tool.indexOf('/');
      return `mcp__${tool.slice(0, slash)}__${tool.slice(slash + 1)}`;
    });
    // One argv element: Claude's variadic option must not consume a following prompt or managed flag.
    args.push(CLAUDE_BRIEFING_FLAGS.allowTools, tools.join(','));
  }
  if (briefing.instructions !== undefined) {
    const path = join(directory, `${id}.instructions.txt`);
    await writeOwnedFile(path, briefing.instructions, filesToCleanup);
    // Native snapshots otherwise retain the previous launch's prompt until compaction, despite a new append flag.
    args.push(CLAUDE_BRIEFING_FLAGS.appendSystemPromptFile, path, CLAUDE_BRIEFING_FLAGS.systemPromptSnapshot, 'off');
  }
  return { args, env };
}

async function writeOwnedFile(path: string, value: string, filesToCleanup: string[]): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  // Track only files we created, including a file whose subsequent write fails.
  filesToCleanup.push(path);
  try {
    await file.writeFile(value, 'utf8');
  } finally {
    await file.close();
  }
}
