import { resolve } from 'node:path';
import { z } from 'zod';
import type { AgentNativeInvocation, AgentNativeInvocationResolution } from '@vibecook/puppeteer-core';
import type { KimiPermissionMode } from '../driver.js';

const SESSION_FLAGS = new Set(['-S', '-r', '--resume', '--session']);
const SAFE_NATIVE_SESSION_ID = /^[A-Za-z0-9._-]+$/u;
const REJECTED = 'custom arguments are not compatible with the managed Kimi launch';
const ContinuationPathSchema = z.string().trim().min(1).max(8_192);
const KimiContinuationStateSchema = z.union([
  z.strictObject({ version: z.literal(1), home: ContinuationPathSchema }),
  z
    .strictObject({
      version: z.literal(2),
      home: ContinuationPathSchema.optional(),
      imposterRoot: ContinuationPathSchema.optional(),
    })
    .refine((value) => value.home !== undefined || value.imposterRoot !== undefined),
]);

export interface KimiNativeInvocationOptions {
  model?: string;
  permissionMode?: KimiPermissionMode;
  plan?: boolean;
  agent?: string;
  agentFile?: string;
  executable?: string;
  env?: Record<string, string>;
  kimiHome?: string;
}

export interface RestoreKimiContinuationOptions {
  imposterExecutable?: string;
}

export function normalizeKimiNativeInvocation(
  invocation: AgentNativeInvocation,
): AgentNativeInvocationResolution<KimiNativeInvocationOptions> {
  if (invocation.providerId !== 'kimi') return { status: 'rejected', reason: 'provider mismatch' };
  let resume: string | undefined;
  const options: KimiNativeInvocationOptions = {};

  for (let index = 0; index < invocation.argv.length; index += 1) {
    const argument = invocation.argv[index]!;
    if (SESSION_FLAGS.has(argument)) {
      const value = invocation.argv[index + 1];
      if (resume || !value || value === '.' || value === '..' || !SAFE_NATIVE_SESSION_ID.test(value)) {
        return { status: 'rejected', reason: REJECTED };
      }
      resume = value;
      index += 1;
      continue;
    }
    if (argument === '--yolo' || argument === '--auto') {
      if (options.permissionMode) return { status: 'rejected', reason: REJECTED };
      options.permissionMode = argument === '--yolo' ? 'yolo' : 'auto';
      continue;
    }
    if (argument === '--plan') {
      if (options.plan) return { status: 'rejected', reason: REJECTED };
      options.plan = true;
      continue;
    }
    const field =
      argument === '--model'
        ? 'model'
        : argument === '--agent'
          ? 'agent'
          : argument === '--agent-file'
            ? 'agentFile'
            : undefined;
    const value = field ? invocation.argv[index + 1] : undefined;
    if (!field || !value || value.startsWith('-') || options[field] !== undefined) {
      return { status: 'rejected', reason: REJECTED };
    }
    options[field] = value;
    index += 1;
  }

  if (resume && (options.agent || options.agentFile)) return { status: 'rejected', reason: REJECTED };
  const nativeHome = invocation.environment.KIMI_CODE_HOME;
  if (nativeHome) options.kimiHome = resolve(invocation.cwd, nativeHome);
  if (invocation.implementation.kind === 'imposter') {
    const stateRoot = invocation.implementation.stateRoot;
    if (!stateRoot) return { status: 'rejected', reason: 'Kimi imposter requires an isolated state root' };
    options.executable = invocation.implementation.executable;
    options.kimiHome = stateRoot;
    options.env = {
      AI_PERSONA: 'kimi',
      KIMI_CODE_HOME: stateRoot,
      PUPPETEER_IMPOSTER_HOME: stateRoot,
    };
  }
  return {
    status: 'accepted',
    ...(resume ? { resume } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}

export function captureKimiContinuationState(
  options: KimiNativeInvocationOptions | undefined,
  cwd: string,
  processEnvironment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const home = options?.kimiHome ?? options?.env?.KIMI_CODE_HOME ?? processEnvironment.KIMI_CODE_HOME;
  const imposterRoot = options?.env?.PUPPETEER_IMPOSTER_HOME;
  if (!home?.trim() && !imposterRoot?.trim()) return undefined;
  return JSON.stringify({
    version: 2,
    ...(home?.trim() ? { home: resolve(cwd, home) } : {}),
    ...(imposterRoot?.trim() ? { imposterRoot: resolve(cwd, imposterRoot) } : {}),
  });
}

export function restoreKimiContinuationState(
  state: string | undefined,
  options: RestoreKimiContinuationOptions = {},
): KimiNativeInvocationOptions | undefined {
  if (!state) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(state);
  } catch (cause) {
    throw new Error('invalid Kimi continuation state', { cause });
  }
  const parsed = KimiContinuationStateSchema.safeParse(decoded);
  if (!parsed.success) throw new Error('invalid Kimi continuation state', { cause: parsed.error });
  const value = parsed.data;
  if (value.version === 1) return { kimiHome: value.home };
  if (value.imposterRoot && !options.imposterExecutable) {
    throw new Error('Kimi continuation requires the configured imposter executable');
  }
  return {
    ...(value.imposterRoot ? { executable: options.imposterExecutable } : {}),
    ...(value.home ? { kimiHome: value.home } : {}),
    ...(value.imposterRoot
      ? {
          kimiHome: value.imposterRoot,
          env: {
            AI_PERSONA: 'kimi',
            KIMI_CODE_HOME: value.imposterRoot,
            PUPPETEER_IMPOSTER_HOME: value.imposterRoot,
          },
        }
      : {}),
  };
}
