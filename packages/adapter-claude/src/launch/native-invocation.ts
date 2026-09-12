import { resolve } from 'node:path';
import { z } from 'zod';
import type { AgentNativeInvocation, AgentNativeInvocationResolution } from '@vibecook/puppeteer-core';
import type { ClaudeSettingSource } from '../observation/status-channel.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REJECTED = 'custom arguments are not compatible with the managed Claude launch';
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
}

export interface RestoreClaudeContinuationOptions {
  imposterExecutable?: string | undefined;
}

/** Claude owns its CLI grammar, config-root semantics, and imposter mapping. */
export function normalizeClaudeNativeInvocation(
  invocation: AgentNativeInvocation,
): AgentNativeInvocationResolution<ClaudeNativeInvocationOptions> {
  if (invocation.providerId !== 'claude') return { status: 'rejected', reason: 'provider mismatch' };
  let resume: string | undefined;
  let resumeInvocation: string[] | undefined;
  const options: ClaudeNativeInvocationOptions = {};

  for (let index = 0; index < invocation.argv.length; index += 1) {
    const argument = invocation.argv[index]!;
    if (argument === '--continue' || argument === '-c') {
      if (resume || resumeInvocation) return { status: 'rejected', reason: REJECTED };
      resumeInvocation = [argument];
      continue;
    }
    if (argument === '--resume' || argument === '-r') {
      if (resume || resumeInvocation) return { status: 'rejected', reason: REJECTED };
      const selection = invocation.argv[index + 1];
      if (selection && !selection.startsWith('-')) {
        if (UUID.test(selection)) resume = selection;
        else resumeInvocation = [argument, selection];
        index += 1;
      } else {
        resumeInvocation = [argument];
      }
      continue;
    }
    if (argument === '--setting-sources') {
      const value = invocation.argv[index + 1];
      const sources = value?.split(',');
      if (
        !value ||
        options.settingSources !== undefined ||
        !sources ||
        sources.some((source) => !['user', 'project', 'local'].includes(source))
      ) {
        return { status: 'rejected', reason: REJECTED };
      }
      options.settingSources = sources as ClaudeSettingSource[];
      index += 1;
      continue;
    }
    const field =
      argument === '--model'
        ? 'model'
        : argument === '--effort'
          ? 'effort'
          : argument === '--permission-mode'
            ? 'permissionMode'
            : undefined;
    const value = field ? invocation.argv[index + 1] : undefined;
    if (!field || !value || value.startsWith('-') || options[field] !== undefined) {
      return { status: 'rejected', reason: REJECTED };
    }
    options[field] = value;
    index += 1;
  }

  const configDir = invocation.environment.CLAUDE_CONFIG_DIR;
  if (configDir) options.configDir = resolve(invocation.cwd, configDir);
  if (resumeInvocation) options.resumeInvocation = resumeInvocation;
  if (invocation.implementation.kind === 'imposter') {
    const stateRoot = invocation.implementation.stateRoot;
    if (!stateRoot) return { status: 'rejected', reason: 'Claude imposter requires an isolated state root' };
    options.executable = invocation.implementation.executable;
    options.env = { AI_PERSONA: 'claude', PUPPETEER_IMPOSTER_HOME: stateRoot };
  }
  return {
    status: 'accepted',
    ...(resume ? { resume } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
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
