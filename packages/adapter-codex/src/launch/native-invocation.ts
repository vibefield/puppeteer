import { resolve } from 'node:path';
import { z } from 'zod';
import type { AgentNativeInvocation, AgentNativeInvocationResolution } from '@vibecook/puppeteer-core';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ContinuationPathSchema = z.string().trim().min(1).max(8_192);
const CodexContinuationStateSchema = z.union([
  z.strictObject({ version: z.literal(1), home: ContinuationPathSchema }),
  z
    .strictObject({
      version: z.literal(2),
      home: ContinuationPathSchema.optional(),
      imposterRoot: ContinuationPathSchema.optional(),
    })
    .refine((value) => value.home !== undefined || value.imposterRoot !== undefined),
]);

export interface CodexNativeInvocationOptions {
  resumeInvocation?: string[];
  executable?: string;
  env?: Record<string, string>;
  appServerEnv?: Record<string, string>;
}

export interface RestoreCodexContinuationOptions {
  imposterExecutable?: string;
}

/** Codex owns resume grammar and the app-server/socket topology behind it. */
export function normalizeCodexNativeInvocation(
  invocation: AgentNativeInvocation,
): AgentNativeInvocationResolution<CodexNativeInvocationOptions> {
  if (invocation.providerId !== 'codex') return { status: 'rejected', reason: 'provider mismatch' };
  if (invocation.argv.some((argument) => argument === '--remote' || argument === '--remote-auth-token-env')) {
    return { status: 'rejected', reason: 'Codex remote transport arguments are owned by the adapter' };
  }

  let resume: string | undefined;
  const options: CodexNativeInvocationOptions = {};
  if (invocation.argv.length > 0) {
    if (invocation.argv[0] !== 'resume') {
      return { status: 'rejected', reason: 'custom arguments are not compatible with the managed Codex launch' };
    }
    if (invocation.argv.length === 2 && UUID.test(invocation.argv[1]!)) resume = invocation.argv[1];
    else if (
      invocation.argv.length === 1 ||
      (invocation.argv.length === 2 && (invocation.argv[1] === '--last' || invocation.argv[1] === '--all'))
    ) {
      options.resumeInvocation = [...invocation.argv];
    } else {
      return { status: 'rejected', reason: 'custom arguments are not compatible with the managed Codex launch' };
    }
  }

  const sharedEnv: Record<string, string> = {};
  const codexHome = invocation.environment.CODEX_HOME;
  if (codexHome) sharedEnv.CODEX_HOME = resolve(invocation.cwd, codexHome);
  if (invocation.implementation.kind === 'imposter') {
    const stateRoot = invocation.implementation.stateRoot;
    if (!stateRoot) return { status: 'rejected', reason: 'Codex imposter requires an isolated state root' };
    options.executable = invocation.implementation.executable;
    sharedEnv.AI_PERSONA = 'codex';
    sharedEnv.PUPPETEER_IMPOSTER_HOME = stateRoot;
  }
  if (Object.keys(sharedEnv).length > 0) {
    options.env = { ...sharedEnv };
    options.appServerEnv = { ...sharedEnv };
  }
  return {
    status: 'accepted',
    ...(resume ? { resume } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}

export function captureCodexContinuationState(
  options: CodexNativeInvocationOptions | undefined,
  cwd: string,
  processEnvironment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const environment = options?.appServerEnv ?? options?.env;
  const home = environment?.CODEX_HOME ?? processEnvironment.CODEX_HOME;
  const imposterRoot = environment?.PUPPETEER_IMPOSTER_HOME;
  if (!home?.trim() && !imposterRoot?.trim()) return undefined;
  return JSON.stringify({
    version: 2,
    ...(home?.trim() ? { home: resolve(cwd, home) } : {}),
    ...(imposterRoot?.trim() ? { imposterRoot: resolve(cwd, imposterRoot) } : {}),
  });
}

export function restoreCodexContinuationState(
  state: string | undefined,
  options: RestoreCodexContinuationOptions = {},
): CodexNativeInvocationOptions | undefined {
  if (!state) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(state);
  } catch (cause) {
    throw new Error('invalid Codex continuation state', { cause });
  }
  const parsed = CodexContinuationStateSchema.safeParse(decoded);
  if (!parsed.success) throw new Error('invalid Codex continuation state', { cause: parsed.error });
  const value = parsed.data;
  if (value.version === 1) {
    return {
      env: { CODEX_HOME: value.home },
      appServerEnv: { CODEX_HOME: value.home },
    };
  }
  if (value.imposterRoot && !options.imposterExecutable) {
    throw new Error('Codex continuation requires the configured imposter executable');
  }
  const environment: Record<string, string> = {
    ...(value.home ? { CODEX_HOME: value.home } : {}),
    ...(value.imposterRoot ? { AI_PERSONA: 'codex', PUPPETEER_IMPOSTER_HOME: value.imposterRoot } : {}),
  };
  return {
    ...(value.imposterRoot ? { executable: options.imposterExecutable } : {}),
    env: { ...environment },
    appServerEnv: { ...environment },
  };
}
