import { z } from 'zod';
import { AgentLaunchRefusedError } from './launch.js';
import type { AgentBriefingCapabilities } from './provider.js';

/** Portable server names, also safe as one native configuration key and one tool-name prefix. */
export const RunMcpServerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u)
  .refine((name) => !['__proto__', 'constructor', 'prototype'].includes(name));

const ArgumentSchema = z
  .string()
  .max(65_536)
  .refine((value) => !value.includes('\0'));
export const RunMcpServerSchema = z.strictObject({
  command: ArgumentSchema.refine((value) => value.trim().length > 0),
  args: z.array(ArgumentSchema).max(512).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), ArgumentSchema).optional(),
});
export type RunMcpServer = z.infer<typeof RunMcpServerSchema>;

/** A server/tool pair, or server/* for every tool of exactly that server; never a built-in tool. */
export const RunToolAllowanceSchema = z
  .string()
  .max(386)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/(?:\*|[A-Za-z0-9_.-]{1,256})$/u);

/**
 * Inputs for one process run. Re-supply them on resume; they are never captured in a continuation.
 * Servers supplement native configuration. Tool allowances affect only servers declared in this briefing.
 */
export const AgentRunBriefingSchema = z
  .strictObject({
    mcpServers: z.record(RunMcpServerNameSchema, RunMcpServerSchema).optional(),
    allowTools: z.array(RunToolAllowanceSchema).max(1_024).optional(),
    instructions: ArgumentSchema.optional(),
  })
  .superRefine((briefing, context) => {
    if (Object.keys(briefing.mcpServers ?? {}).length > 64)
      context.addIssue({ code: 'custom', path: ['mcpServers'], message: 'Too many servers.' });
    for (const [index, allowance] of (briefing.allowTools ?? []).entries()) {
      const server = allowance.slice(0, allowance.indexOf('/'));
      if (!Object.hasOwn(briefing.mcpServers ?? {}, server))
        context.addIssue({ code: 'custom', path: ['allowTools', index], message: 'The server is not in this run.' });
    }
  });
export type AgentRunBriefing = z.infer<typeof AgentRunBriefingSchema>;
export type AgentBriefingField = keyof AgentRunBriefing;
export const AGENT_BRIEFING_FIELDS = ['mcpServers', 'allowTools', 'instructions'] as const;

/** Pick only launch fields; provider options and host policy are deliberately separate. */
export function pickAgentBriefing(options: AgentRunBriefing): AgentRunBriefing {
  return {
    ...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
    ...(options.allowTools === undefined ? {} : { allowTools: options.allowTools }),
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
  };
}

/** Validate and copy before a provider starts anything. Refusals never repeat command, environment or prompt values. */
export function validateAgentBriefing(
  options: AgentRunBriefing,
  capabilities: AgentBriefingCapabilities | undefined,
  label: string,
): AgentRunBriefing {
  for (const field of AGENT_BRIEFING_FIELDS) {
    if (options[field] !== undefined && capabilities?.[field] !== true)
      throw new AgentLaunchRefusedError(
        'UNSUPPORTED_LAUNCH_FIELD',
        `${label} does not support launch field: ${field}.`,
      );
  }
  const parsed = AgentRunBriefingSchema.safeParse(pickAgentBriefing(options));
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    throw new AgentLaunchRefusedError(
      'INVALID_LAUNCH_FIELD',
      `Invalid launch field: ${AGENT_BRIEFING_FIELDS.includes(field as AgentBriefingField) ? String(field) : 'briefing'}.`,
    );
  }
  return parsed.data;
}

/** Exact tool names and the optional whole-server grant, without any vendor's tool prefix. */
export function runToolAllowances(briefing: AgentRunBriefing, server: string): string[] {
  const prefix = `${server}/`;
  return [
    ...new Set(
      (briefing.allowTools ?? []).filter((tool) => tool.startsWith(prefix)).map((tool) => tool.slice(prefix.length)),
    ),
  ];
}
