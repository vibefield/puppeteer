import { z } from 'zod';
import { AgentLaunchRefusedError, isAgentLaunchRefusedError } from './launch.js';
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
        field,
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

/**
 * What a launch does with a briefing field it cannot honour. `refuse` (the default) fails the launch, naming the field.
 * `withhold` launches without it and says so in the receipt: a person's own typed command is not refused for what the
 * host wanted to add to it. Malformed data is the host's error and is refused either way.
 */
export type AgentBriefingRefusalPolicy = 'refuse' | 'withhold';

/** One field a launch went ahead without, and the refusal code that would otherwise have ended it. */
export interface AgentBriefingWithheld {
  readonly field: AgentBriefingField;
  readonly code: string;
}

/** What a run's launch did with the briefing it was asked to carry. Absent when it was asked to carry nothing. */
export interface AgentBriefingReceipt {
  applied: AgentBriefingField[];
  withheld: AgentBriefingWithheld[];
}

/** A briefing as far as a launch has settled it: what still goes, and what has been withheld so far. */
export interface AgentBriefingSettlement {
  briefing: AgentRunBriefing;
  withheld: AgentBriefingWithheld[];
}

/** An allowance must name a server of this briefing (the schema above), so allowances leave with their servers. */
function withholdField(
  settled: AgentBriefingSettlement,
  field: AgentBriefingField,
  code: string,
): AgentBriefingSettlement {
  const briefing = { ...settled.briefing };
  const withheld = [...settled.withheld];
  for (const name of field === 'mcpServers' ? (['mcpServers', 'allowTools'] as const) : [field]) {
    if (briefing[name] === undefined) continue;
    delete briefing[name];
    withheld.push({ field: name, code });
  }
  return { briefing, withheld };
}

/**
 * The one reading of a refusal under a policy: a refusal naming a field still in the briefing is absorbed under
 * `withhold`; anything else propagates, including every refusal that is not about a field.
 */
export function absorbBriefingRefusal(
  settled: AgentBriefingSettlement,
  policy: AgentBriefingRefusalPolicy | undefined,
  error: unknown,
): AgentBriefingSettlement {
  if (policy !== 'withhold' || !isAgentLaunchRefusedError(error)) throw error;
  if (error.field === undefined || settled.briefing[error.field] === undefined) throw error;
  return withholdField(settled, error.field, error.code);
}

/** {@link validateAgentBriefing} under a policy, carrying what an earlier step withheld. */
export function settleAgentBriefing(
  options: AgentRunBriefing,
  capabilities: AgentBriefingCapabilities | undefined,
  label: string,
  policy?: AgentBriefingRefusalPolicy,
  withheldSoFar: readonly AgentBriefingWithheld[] = [],
): AgentBriefingSettlement {
  let settled: AgentBriefingSettlement = { briefing: pickAgentBriefing(options), withheld: [...withheldSoFar] };
  // Each pass removes a field that was present, so this ends.
  for (;;) {
    try {
      return { briefing: validateAgentBriefing(settled.briefing, capabilities, label), withheld: settled.withheld };
    } catch (error) {
      settled = absorbBriefingRefusal(settled, policy, error);
    }
  }
}

/** Run a check that may refuse a field; under `withhold` the field leaves and the check runs again on what remains. */
export async function withholdUntilAccepted<T>(
  start: AgentBriefingSettlement,
  policy: AgentBriefingRefusalPolicy | undefined,
  check: (briefing: AgentRunBriefing) => T | Promise<T>,
): Promise<{ result: T; settled: AgentBriefingSettlement }> {
  let settled = start;
  for (;;) {
    try {
      return { result: await check(settled.briefing), settled };
    } catch (error) {
      settled = absorbBriefingRefusal(settled, policy, error);
    }
  }
}

/** Launch options carrying exactly this briefing: a withheld field must not survive a spread of the originals. */
export function withAgentBriefing<T extends AgentRunBriefing>(options: T, briefing: AgentRunBriefing): T {
  const { mcpServers: _mcpServers, allowTools: _allowTools, instructions: _instructions, ...rest } = options;
  return { ...rest, ...briefing } as T;
}

/** The receipt for a run that asked for `asked`, each field reported once. */
export function agentBriefingReceipt(
  asked: readonly AgentBriefingField[],
  withheld: readonly AgentBriefingWithheld[],
): AgentBriefingReceipt | undefined {
  if (asked.length === 0) return undefined;
  const once = withheld.filter((entry, index) => withheld.findIndex(({ field }) => field === entry.field) === index);
  const out = new Set(once.map(({ field }) => field));
  return { applied: asked.filter((field) => !out.has(field)), withheld: once.map((entry) => ({ ...entry })) };
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
