import { resolve } from 'node:path';
import { z } from 'zod';
import type { AgentNativeInvocation, AgentNativeInvocationResolution } from '@vibecook/puppeteer-core';

const SAFE_NATIVE_SESSION_ID = /^[A-Za-z0-9._-]+$/u;
const ContinuationPathSchema = z.string().trim().min(1).max(8_192);
/**
 * Version 1 recorded only an Imposter root. Version 2 adds the data root a
 * profile binds, so a resumed session lands in the same account. Version 1
 * documents keep decoding.
 */
const OpenCodeContinuationStateSchema = z.union([
  z.strictObject({ version: z.literal(1), imposterRoot: ContinuationPathSchema }),
  z
    .strictObject({
      version: z.literal(2),
      dataHome: ContinuationPathSchema.optional(),
      imposterRoot: ContinuationPathSchema.optional(),
    })
    .refine((value) => value.dataHome !== undefined || value.imposterRoot !== undefined),
]);

export interface OpenCodeNativeInvocationOptions {
  executable?: string | undefined;
  env?: Record<string, string> | undefined;
}

export interface RestoreOpenCodeContinuationOptions {
  imposterExecutable?: string | undefined;
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
  const environment: Record<string, string> = {};
  // OpenCode keys its credentials, database, and logs off XDG_DATA_HOME
  // (`$XDG_DATA_HOME/opencode/{auth.json,opencode.db,log}`, verified 2026-09-06
  // on 1.18.23), so this is the variable an account profile binds. The adapter
  // forwards it to both the private backend and the attached TUI.
  const dataHome = invocation.environment.XDG_DATA_HOME;
  if (dataHome) environment.XDG_DATA_HOME = resolve(invocation.cwd, dataHome);
  if (invocation.implementation.kind === 'imposter') {
    const stateRoot = invocation.implementation.stateRoot;
    if (!stateRoot) return { status: 'rejected', reason: 'OpenCode imposter requires an isolated state root' };
    options.executable = invocation.implementation.executable;
    environment.AI_PERSONA = 'opencode';
    environment.PUPPETEER_IMPOSTER_HOME = stateRoot;
  }
  if (Object.keys(environment).length > 0) options.env = environment;
  return {
    status: 'accepted',
    ...(resume ? { resume } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}

/**
 * Only the launch's own environment is captured. Unlike a provider-specific
 * root variable, XDG_DATA_HOME is a general one the host process may carry for
 * unrelated reasons, so it is never read from `process.env` here: that would
 * pin an unrelated directory into every continuation.
 */
export function captureOpenCodeContinuationState(
  options: OpenCodeNativeInvocationOptions | undefined,
  cwd: string,
): string | undefined {
  const dataHome = options?.env?.XDG_DATA_HOME;
  const imposterRoot = options?.env?.PUPPETEER_IMPOSTER_HOME;
  if (!dataHome?.trim() && !imposterRoot?.trim()) return undefined;
  return JSON.stringify({
    version: 2,
    ...(dataHome?.trim() ? { dataHome: resolve(cwd, dataHome) } : {}),
    ...(imposterRoot?.trim() ? { imposterRoot: resolve(cwd, imposterRoot) } : {}),
  });
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
  const value = parsed.data;
  const imposterRoot = value.imposterRoot;
  if (imposterRoot && !options.imposterExecutable) {
    throw new Error('OpenCode continuation requires the configured imposter executable');
  }
  return {
    ...(imposterRoot ? { executable: options.imposterExecutable } : {}),
    env: {
      ...(value.version === 2 && value.dataHome ? { XDG_DATA_HOME: value.dataHome } : {}),
      ...(imposterRoot ? { AI_PERSONA: 'opencode', PUPPETEER_IMPOSTER_HOME: imposterRoot } : {}),
    },
  };
}
