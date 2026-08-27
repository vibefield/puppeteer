import { resolve } from 'node:path';
import { z } from 'zod';
import type { AgentNativeInvocation, AgentNativeInvocationResolution } from '@vibecook/puppeteer-core';

const SAFE_NATIVE_SESSION_ID = /^[A-Za-z0-9._-]+$/u;
const OpenCodeContinuationStateSchema = z.strictObject({
  version: z.literal(1),
  imposterRoot: z.string().trim().min(1).max(8_192),
});

export interface OpenCodeNativeInvocationOptions {
  executable?: string;
  env?: Record<string, string>;
}

export interface RestoreOpenCodeContinuationOptions {
  imposterExecutable?: string;
}

/** OpenCode maps native session selection onto its private HTTP/SSE backend and exact attach. */
export function normalizeOpenCodeNativeInvocation(
  invocation: AgentNativeInvocation,
): AgentNativeInvocationResolution<OpenCodeNativeInvocationOptions> {
  if (invocation.providerId !== 'opencode') return { status: 'rejected', reason: 'provider mismatch' };
  let resume: string | undefined;
  if (invocation.argv.length > 0) {
    const value = invocation.argv[1];
    if (
      invocation.argv.length !== 2 ||
      (invocation.argv[0] !== '-s' && invocation.argv[0] !== '--session') ||
      !value ||
      value === '.' ||
      value === '..' ||
      !SAFE_NATIVE_SESSION_ID.test(value)
    ) {
      return { status: 'rejected', reason: 'custom arguments are not compatible with the managed OpenCode launch' };
    }
    resume = value;
  }

  const options: OpenCodeNativeInvocationOptions = {};
  if (invocation.implementation.kind === 'imposter') {
    const stateRoot = invocation.implementation.stateRoot;
    if (!stateRoot) return { status: 'rejected', reason: 'OpenCode imposter requires an isolated state root' };
    options.executable = invocation.implementation.executable;
    options.env = { AI_PERSONA: 'opencode', PUPPETEER_IMPOSTER_HOME: stateRoot };
  }
  return {
    status: 'accepted',
    ...(resume ? { resume } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}

export function captureOpenCodeContinuationState(
  options: OpenCodeNativeInvocationOptions | undefined,
  cwd: string,
): string | undefined {
  const imposterRoot = options?.env?.PUPPETEER_IMPOSTER_HOME;
  return imposterRoot?.trim() ? JSON.stringify({ version: 1, imposterRoot: resolve(cwd, imposterRoot) }) : undefined;
}

export function restoreOpenCodeContinuationState(
  state: string | undefined,
  options: RestoreOpenCodeContinuationOptions = {},
): OpenCodeNativeInvocationOptions | undefined {
  if (!state) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(state);
  } catch (cause) {
    throw new Error('invalid OpenCode continuation state', { cause });
  }
  const parsed = OpenCodeContinuationStateSchema.safeParse(decoded);
  if (!parsed.success) throw new Error('invalid OpenCode continuation state', { cause: parsed.error });
  if (!options.imposterExecutable) {
    throw new Error('OpenCode continuation requires the configured imposter executable');
  }
  return {
    executable: options.imposterExecutable,
    env: {
      AI_PERSONA: 'opencode',
      PUPPETEER_IMPOSTER_HOME: parsed.data.imposterRoot,
    },
  };
}
