import { resolve } from 'node:path';
import { z } from 'zod';
import type { AgentNativeInvocation, AgentNativeInvocationResolution } from '@vibecook/puppeteer-core';
const SAFE_ID = /^[A-Za-z0-9._-]+$/u;
const REJECTED = 'custom arguments are not compatible with the managed Antigravity launch';
const StateSchema = z
  .strictObject({
    version: z.literal(1),
    home: z.string().optional(),
    dataRoot: z.string().optional(),
    imposterRoot: z.string().optional(),
  })
  .refine((value) => value.home || value.dataRoot)
  .refine((value) => !value.imposterRoot || value.dataRoot, {
    message: 'imposter continuation state requires dataRoot',
    path: ['dataRoot'],
  });
export interface AntigravityNativeInvocationOptions {
  executable?: string | undefined;
  env?: Record<string, string> | undefined;
  antigravityHome?: string | undefined;
  dataRoot?: string | undefined;
  model?: string | undefined;
  effort?: 'low' | 'medium' | 'high' | undefined;
  mode?: 'default' | 'accept-edits' | 'plan' | undefined;
  skipPermissions?: boolean | undefined;
  sandbox?: boolean | undefined;
  agent?: string | undefined;
  project?: string | undefined;
  addDirs?: string[] | undefined;
}
export function normalizeAntigravityNativeInvocation(
  invocation: AgentNativeInvocation,
): AgentNativeInvocationResolution<AntigravityNativeInvocationOptions> {
  if (invocation.providerId !== 'antigravity') return { status: 'rejected', reason: 'provider mismatch' };
  let resume: string | undefined;
  const options: AntigravityNativeInvocationOptions = {};
  for (let index = 0; index < invocation.argv.length; index += 1) {
    const argument = invocation.argv[index]!;
    const separator = argument.indexOf('=');
    const flag = separator < 0 ? argument : argument.slice(0, separator);
    const inlineValue = separator < 0 ? undefined : argument.slice(separator + 1);
    if (flag === '--conversation') {
      const value = inlineValue ?? invocation.argv[++index];
      if (resume || !value || !SAFE_ID.test(value)) return { status: 'rejected', reason: REJECTED };
      resume = value;
      continue;
    }
    if (flag === '--dangerously-skip-permissions') {
      if (inlineValue !== undefined || options.skipPermissions) return { status: 'rejected', reason: REJECTED };
      options.skipPermissions = true;
      continue;
    }
    if (flag === '--sandbox') {
      if (inlineValue !== undefined || options.sandbox) return { status: 'rejected', reason: REJECTED };
      options.sandbox = true;
      continue;
    }
    if (flag === '--add-dir') {
      const value = inlineValue ?? invocation.argv[++index];
      if (!value || value.startsWith('-')) return { status: 'rejected', reason: REJECTED };
      (options.addDirs ??= []).push(resolve(invocation.cwd, value));
      continue;
    }
    const field =
      flag === '--model'
        ? 'model'
        : flag === '--effort'
          ? 'effort'
          : flag === '--mode'
            ? 'mode'
            : flag === '--agent'
              ? 'agent'
              : flag === '--project'
                ? 'project'
                : undefined;
    const value = field ? (inlineValue ?? invocation.argv[++index]) : undefined;
    if (!field || !value || value.startsWith('-') || options[field] !== undefined)
      return { status: 'rejected', reason: REJECTED };
    if (field === 'effort' && !['low', 'medium', 'high'].includes(value))
      return { status: 'rejected', reason: REJECTED };
    if (field === 'mode' && !['default', 'accept-edits', 'plan'].includes(value))
      return { status: 'rejected', reason: REJECTED };
    (options as Record<string, unknown>)[field] = value;
  }
  const home = invocation.environment.PUPPETEER_ANTIGRAVITY_HOME;
  if (home) options.antigravityHome = resolve(invocation.cwd, home);
  if (invocation.implementation.kind === 'imposter') {
    const root = invocation.implementation.stateRoot;
    if (!root) return { status: 'rejected', reason: 'Antigravity imposter requires an isolated state root' };
    options.executable = invocation.implementation.executable;
    options.dataRoot = root;
    options.env = { AI_PERSONA: 'antigravity', PUPPETEER_ANTIGRAVITY_DATA_ROOT: root, PUPPETEER_IMPOSTER_HOME: root };
  }
  return { status: 'accepted', ...(resume ? { resume } : {}), ...(Object.keys(options).length ? { options } : {}) };
}
export function captureAntigravityContinuationState(
  options: AntigravityNativeInvocationOptions | undefined,
  cwd: string,
): string | undefined {
  const home = options?.antigravityHome ?? options?.env?.PUPPETEER_ANTIGRAVITY_HOME;
  const dataRoot = options?.dataRoot ?? options?.env?.PUPPETEER_ANTIGRAVITY_DATA_ROOT;
  const imposterRoot = options?.env?.PUPPETEER_IMPOSTER_HOME;
  if (!home && !dataRoot) return undefined;
  return JSON.stringify({
    version: 1,
    ...(home ? { home: resolve(cwd, home) } : {}),
    ...(dataRoot ? { dataRoot: resolve(cwd, dataRoot) } : {}),
    ...(imposterRoot ? { imposterRoot: resolve(cwd, imposterRoot) } : {}),
  });
}
export function restoreAntigravityContinuationState(
  state: string | undefined,
  options: { imposterExecutable?: string | undefined } = {},
): AntigravityNativeInvocationOptions | undefined {
  if (!state) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(state);
  } catch (cause) {
    throw new Error('invalid Antigravity continuation state', { cause });
  }
  const parsed = StateSchema.safeParse(decoded);
  if (!parsed.success) throw new Error('invalid Antigravity continuation state', { cause: parsed.error });
  if (parsed.data.imposterRoot && !options.imposterExecutable)
    throw new Error('Antigravity continuation requires the configured imposter executable');
  return {
    ...(parsed.data.imposterRoot
      ? {
          executable: options.imposterExecutable,
          env: {
            AI_PERSONA: 'antigravity',
            PUPPETEER_ANTIGRAVITY_DATA_ROOT: parsed.data.dataRoot!,
            PUPPETEER_IMPOSTER_HOME: parsed.data.imposterRoot,
          },
        }
      : {}),
    ...(parsed.data.home ? { antigravityHome: parsed.data.home } : {}),
    ...(parsed.data.dataRoot ? { dataRoot: parsed.data.dataRoot } : {}),
  };
}
