import { resolve } from 'node:path';
import { readInvocation } from './invocation-grammar.js';
import { z } from 'zod';
import type { AgentNativeInvocation, AgentNativeInvocationResolution } from '@vibecook/puppeteer-core';

const ContinuationPathSchema = z.string().trim().min(1).max(8_192);
const GrokContinuationStateSchema = z.union([
  z.strictObject({ version: z.literal(1), home: ContinuationPathSchema }),
  z
    .strictObject({
      version: z.literal(2),
      home: ContinuationPathSchema.optional(),
      imposterRoot: ContinuationPathSchema.optional(),
    })
    .refine((value) => value.home !== undefined || value.imposterRoot !== undefined),
]);

export interface GrokNativeInvocationOptions {
  model?: string | undefined;
  permissionMode?: string | undefined;
  sandbox?: string | undefined;
  resumeLatest?: boolean | undefined;
  executable?: string | undefined;
  appServerEnv?: Record<string, string> | undefined;
}

export interface RestoreGrokContinuationOptions {
  imposterExecutable?: string | undefined;
}

const REJECTED = 'custom arguments are not compatible with the managed Grok launch';

/** Grok owns native argv plus its leader, ACP, terminal, and durable-log topology. */
export function normalizeGrokNativeInvocation(
  invocation: AgentNativeInvocation,
): AgentNativeInvocationResolution<GrokNativeInvocationOptions> {
  if (invocation.providerId !== 'grok') return { status: 'rejected', reason: 'provider mismatch' };
  const reading = readInvocation(invocation.argv);
  if (reading.status !== 'accepted') return reading;
  const argv = reading.argv;
  let resume: string | undefined;
  const options: GrokNativeInvocationOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--continue' || argument === '-c') {
      if (resume || options.resumeLatest) return { status: 'rejected', reason: REJECTED, argument };
      options.resumeLatest = true;
      continue;
    }
    if (argument === '--resume' || argument === '-r') {
      if (resume || options.resumeLatest) return { status: 'rejected', reason: REJECTED, argument };
      const value = argv[index + 1];
      if (value && !value.startsWith('-')) {
        resume = value;
        index += 1;
      } else {
        options.resumeLatest = true;
      }
      continue;
    }
    const field =
      argument === '--model'
        ? 'model'
        : argument === '--permission-mode'
          ? 'permissionMode'
          : argument === '--sandbox'
            ? 'sandbox'
            : undefined;
    const value = field ? argv[index + 1] : undefined;
    if (!field || !value || value.startsWith('-') || options[field] !== undefined) {
      return { status: 'rejected', reason: REJECTED, argument };
    }
    options[field] = value;
    index += 1;
  }

  const appServerEnv: Record<string, string> = {};
  const grokHome = invocation.environment.GROK_HOME;
  if (grokHome) appServerEnv.GROK_HOME = resolve(invocation.cwd, grokHome);
  if (invocation.implementation.kind === 'imposter') {
    const stateRoot = invocation.implementation.stateRoot;
    if (!stateRoot) return { status: 'rejected', reason: 'Grok imposter requires an isolated state root' };
    options.executable = invocation.implementation.executable;
    appServerEnv.AI_PERSONA = 'grok';
    appServerEnv.GROK_HOME = stateRoot;
    appServerEnv.PUPPETEER_IMPOSTER_HOME = stateRoot;
  }
  if (Object.keys(appServerEnv).length > 0) options.appServerEnv = appServerEnv;
  return {
    status: 'accepted',
    ...(resume ? { resume } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}

export function captureGrokContinuationState(
  options: GrokNativeInvocationOptions | undefined,
  cwd: string,
  processEnvironment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const environment = options?.appServerEnv;
  const home = environment?.GROK_HOME ?? processEnvironment.GROK_HOME;
  const imposterRoot = environment?.PUPPETEER_IMPOSTER_HOME;
  if (!home?.trim() && !imposterRoot?.trim()) return undefined;
  return JSON.stringify({
    version: 2,
    ...(home?.trim() ? { home: resolve(cwd, home) } : {}),
    ...(imposterRoot?.trim() ? { imposterRoot: resolve(cwd, imposterRoot) } : {}),
  });
}

export function restoreGrokContinuationState(
  state: string | undefined,
  options: RestoreGrokContinuationOptions = {},
): GrokNativeInvocationOptions | undefined {
  if (!state) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(state);
  } catch (cause) {
    throw new Error('invalid Grok continuation state', { cause });
  }
  const parsed = GrokContinuationStateSchema.safeParse(decoded);
  if (!parsed.success) throw new Error('invalid Grok continuation state', { cause: parsed.error });
  const value = parsed.data;
  if (value.version === 1) return { appServerEnv: { GROK_HOME: value.home } };
  if (value.imposterRoot && !options.imposterExecutable) {
    throw new Error('Grok continuation requires the configured imposter executable');
  }
  return {
    ...(value.imposterRoot ? { executable: options.imposterExecutable } : {}),
    appServerEnv: {
      ...(value.home ? { GROK_HOME: value.home } : {}),
      ...(value.imposterRoot
        ? {
            AI_PERSONA: 'grok',
            GROK_HOME: value.imposterRoot,
            PUPPETEER_IMPOSTER_HOME: value.imposterRoot,
          }
        : {}),
    },
  };
}
