import { resolve } from 'node:path';
import { z } from 'zod';
import type { AgentNativeInvocation, AgentNativeInvocationResolution } from '@vibecook/puppeteer-core';
import type { ClaudeSettingSource } from '../observation/status-channel.js';
import { CLAUDE_ENVIRONMENT_SWITCHES, readClaudeEnvironment, readClaudeInvocation } from './invocation-grammar.js';

/**
 * Every variable of a person's shell that changes what a Claude session is: the config root, and
 * the switches that stand for flags. The provider's allow-list is exactly this, so a shim forwards
 * them and the normalizer reads what the session will inherit.
 */
export const CLAUDE_INVOCATION_ENVIRONMENT: readonly string[] = [
  'CLAUDE_CONFIG_DIR',
  ...CLAUDE_ENVIRONMENT_SWITCHES.map((row) => row.name),
];

const ContinuationPathSchema = z.string().trim().min(1).max(8_192);
const ClaudeContinuationStateSchema = z.union([
  z.strictObject({ version: z.literal(1), configDir: ContinuationPathSchema }),
  z.strictObject({ kind: z.literal('claude'), configDir: ContinuationPathSchema }),
  z
    .strictObject({
      version: z.literal(2),
      configDir: ContinuationPathSchema.optional(),
      imposterRoot: ContinuationPathSchema.optional(),
    })
    .refine((value) => value.configDir !== undefined || value.imposterRoot !== undefined),
]);

export interface ClaudeNativeInvocationOptions {
  model?: string | undefined;
  effort?: string | undefined;
  permissionMode?: string | undefined;
  settingSources?: ClaudeSettingSource[] | undefined;
  configDir?: string | undefined;
  resumeInvocation?: string[] | undefined;
  executable?: string | undefined;
  env?: Record<string, string> | undefined;
  /**
   * Set on every typed launch, never on a host's own spawn: the managed launch then passes only
   * the permission mode the person gave, never a default of its own.
   */
  typed?: true | undefined;
  /** The person's own `-n/--name`; it wins over the host's title. */
  title?: string | undefined;
  /** The person's other arguments, verbatim and in their order (invocation-grammar.ts decides which). */
  carriedArgs?: string[] | undefined;
  /** The operands as typed: the prompt, then any the CLI drops. */
  prompt?: string[] | undefined;
  /**
   * `--restricted` or CLAUDE_CODE_RESTRICTED: Claude reads none of the person's settings files, so
   * the recipe neither delegates to a status line in them nor reads their hook switches.
   */
  readsNoSettingsFiles?: true | undefined;
}

export interface RestoreClaudeContinuationOptions {
  imposterExecutable?: string | undefined;
}

/**
 * The imposter's own grammar (`ai --claude --help`): it takes the managed launch's flags and
 * `-n/--name`, and ignores anything else rather than doing what the CLI would. So an imposter
 * launch keeps to the options it has always mapped and carries nothing.
 */
const IMPOSTER_REFUSAL = 'the Claude imposter does not take it';

/** Claude owns its CLI grammar (invocation-grammar.ts), config-root semantics, and imposter mapping. */
export function normalizeClaudeNativeInvocation(
  invocation: AgentNativeInvocation,
): AgentNativeInvocationResolution<ClaudeNativeInvocationOptions> {
  if (invocation.providerId !== 'claude') return { status: 'rejected', reason: 'provider mismatch' };
  const reading = readClaudeInvocation(invocation.argv);
  if (reading.status === 'passthrough') return { status: 'passthrough', kind: reading.kind, reason: reading.reason };
  if (reading.status === 'rejected') {
    return {
      status: 'rejected',
      reason: reading.reason,
      ...(reading.argument === undefined ? {} : { argument: reading.argument }),
    };
  }
  // The session inherits the whole shell environment: a switch there is read as its flag would be.
  const environment = readClaudeEnvironment(invocation.environment);
  if (environment.refusal) return { status: 'rejected', ...environment.refusal };

  const options: ClaudeNativeInvocationOptions = { typed: true };
  if (reading.model !== undefined) options.model = reading.model;
  if (reading.effort !== undefined) options.effort = reading.effort;
  if (reading.permissionMode !== undefined) options.permissionMode = reading.permissionMode;
  if (reading.settingSources !== undefined)
    options.settingSources = [...reading.settingSources] as ClaudeSettingSource[];
  if (reading.resumeInvocation !== undefined) options.resumeInvocation = [...reading.resumeInvocation];
  if (reading.title !== undefined) options.title = reading.title;
  if (reading.carriedArgs.length > 0) options.carriedArgs = [...reading.carriedArgs];
  if (reading.prompt.length > 0) options.prompt = [...reading.prompt];
  if (reading.readsNoSettingsFiles || environment.readsNoSettingsFiles) options.readsNoSettingsFiles = true;
  const configDir = invocation.environment.CLAUDE_CONFIG_DIR;
  if (configDir) options.configDir = resolve(invocation.cwd, configDir);
  if (invocation.implementation.kind === 'imposter') {
    const beyond =
      reading.firstCarried ??
      reading.prompt[0] ??
      (reading.resumeInvocation?.[0]?.startsWith('--from-pr') ? reading.resumeInvocation[0] : undefined);
    if (beyond !== undefined) return { status: 'rejected', reason: IMPOSTER_REFUSAL, argument: beyond };
    const stateRoot = invocation.implementation.stateRoot;
    if (!stateRoot) return { status: 'rejected', reason: 'Claude imposter requires an isolated state root' };
    options.executable = invocation.implementation.executable;
    options.env = { AI_PERSONA: 'claude', PUPPETEER_IMPOSTER_HOME: stateRoot };
  }
  return { status: 'accepted', ...(reading.resume === undefined ? {} : { resume: reading.resume }), options };
}

export function captureClaudeContinuationState(
  options: ClaudeNativeInvocationOptions | undefined,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configDir =
    typeof options?.configDir === 'string' && options.configDir.trim()
      ? resolve(cwd, options.configDir)
      : environment.CLAUDE_CONFIG_DIR?.trim()
        ? resolve(cwd, environment.CLAUDE_CONFIG_DIR)
        : undefined;
  const imposterRoot = options?.env?.PUPPETEER_IMPOSTER_HOME;
  if (!configDir && !imposterRoot) return undefined;
  return JSON.stringify({
    version: 2,
    ...(configDir ? { configDir } : {}),
    ...(imposterRoot ? { imposterRoot: resolve(cwd, imposterRoot) } : {}),
  });
}

export function restoreClaudeContinuationState(
  state: string | undefined,
  options: RestoreClaudeContinuationOptions = {},
): ClaudeNativeInvocationOptions | undefined {
  if (!state) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(state);
  } catch (cause) {
    throw new Error('invalid Claude continuation state', { cause });
  }
  const parsed = ClaudeContinuationStateSchema.safeParse(decoded);
  if (!parsed.success) throw new Error('invalid Claude continuation state', { cause: parsed.error });
  const value = parsed.data;
  // `kind: claude` migrates Godview's former provider-specific V2 snapshot.
  if ('kind' in value || value.version === 1) return { configDir: value.configDir };
  if (value.imposterRoot && !options.imposterExecutable) {
    throw new Error('Claude continuation requires the configured imposter executable');
  }
  return {
    ...(value.configDir ? { configDir: value.configDir } : {}),
    ...(value.imposterRoot
      ? {
          executable: options.imposterExecutable,
          env: { AI_PERSONA: 'claude', PUPPETEER_IMPOSTER_HOME: value.imposterRoot },
        }
      : {}),
  };
}
