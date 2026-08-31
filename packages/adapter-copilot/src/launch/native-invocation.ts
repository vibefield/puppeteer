import { resolve } from 'node:path';
import { z } from 'zod';
import type { AgentNativeInvocation, AgentNativeInvocationResolution } from '@vibecook/puppeteer-core';

const SAFE_ID = /^[A-Za-z0-9._-]+$/u;
const REJECTED = 'custom arguments are not compatible with the managed Copilot launch';
const StateSchema = z.strictObject({ version: z.literal(1), home: z.string(), imposterRoot: z.string().optional() });
export interface CopilotNativeInvocationOptions {
  executable?: string;
  env?: Record<string, string>;
  copilotHome?: string;
  model?: string;
  effort?: string;
  mode?: 'interactive' | 'plan' | 'autopilot';
  allowAll?: boolean;
  agent?: string;
  context?: string;
  name?: string;
}

export function normalizeCopilotNativeInvocation(
  invocation: AgentNativeInvocation,
): AgentNativeInvocationResolution<CopilotNativeInvocationOptions> {
  if (invocation.providerId !== 'copilot') return { status: 'rejected', reason: 'provider mismatch' };
  let resume: string | undefined;
  const options: CopilotNativeInvocationOptions = {};
  for (let index = 0; index < invocation.argv.length; index += 1) {
    const argument = invocation.argv[index]!;
    const separator = argument.indexOf('=');
    const flag = separator < 0 ? argument : argument.slice(0, separator);
    const inlineValue = separator < 0 ? undefined : argument.slice(separator + 1);
    if (flag === '--resume' || flag === '-r') {
      const value = inlineValue ?? invocation.argv[++index];
      if (resume || !value || !SAFE_ID.test(value)) return { status: 'rejected', reason: REJECTED };
      resume = value;
      continue;
    }
    if (flag === '--allow-all' || flag === '--yolo') {
      if (inlineValue !== undefined || options.allowAll) return { status: 'rejected', reason: REJECTED };
      options.allowAll = true;
      continue;
    }
    if (flag === '--plan') {
      if (inlineValue !== undefined || options.mode) return { status: 'rejected', reason: REJECTED };
      options.mode = 'plan';
      continue;
    }
    const field =
      flag === '--model'
        ? 'model'
        : flag === '--effort' || flag === '--reasoning-effort'
          ? 'effort'
          : flag === '--mode'
            ? 'mode'
            : flag === '--agent'
              ? 'agent'
              : flag === '--context'
                ? 'context'
                : flag === '--name' || flag === '-n'
                  ? 'name'
                  : undefined;
    const value = field ? (inlineValue ?? invocation.argv[++index]) : undefined;
    if (!field || !value || value.startsWith('-') || options[field] !== undefined)
      return { status: 'rejected', reason: REJECTED };
    if (field === 'mode' && !['interactive', 'plan', 'autopilot'].includes(value))
      return { status: 'rejected', reason: REJECTED };
    (options as Record<string, unknown>)[field] = value;
  }
  const home = invocation.environment.COPILOT_HOME;
  if (home) options.copilotHome = resolve(invocation.cwd, home);
  if (invocation.implementation.kind === 'imposter') {
    const root = invocation.implementation.stateRoot;
    if (!root) return { status: 'rejected', reason: 'Copilot imposter requires an isolated state root' };
    options.executable = invocation.implementation.executable;
    options.copilotHome = root;
    options.env = { AI_PERSONA: 'copilot', COPILOT_HOME: root, PUPPETEER_IMPOSTER_HOME: root };
  }
  return { status: 'accepted', ...(resume ? { resume } : {}), ...(Object.keys(options).length ? { options } : {}) };
}
export function captureCopilotContinuationState(
  options: CopilotNativeInvocationOptions | undefined,
  cwd: string,
): string | undefined {
  const home = options?.copilotHome ?? options?.env?.COPILOT_HOME ?? process.env.COPILOT_HOME;
  const imposterRoot = options?.env?.PUPPETEER_IMPOSTER_HOME;
  if (!home) return undefined;
  return JSON.stringify({
    version: 1,
    home: resolve(cwd, home),
    ...(imposterRoot ? { imposterRoot: resolve(cwd, imposterRoot) } : {}),
  });
}
export function restoreCopilotContinuationState(
  state: string | undefined,
  options: { imposterExecutable?: string } = {},
): CopilotNativeInvocationOptions | undefined {
  if (!state) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(state);
  } catch (cause) {
    throw new Error('invalid Copilot continuation state', { cause });
  }
  const parsed = StateSchema.safeParse(decoded);
  if (!parsed.success) throw new Error('invalid Copilot continuation state', { cause: parsed.error });
  if (parsed.data.imposterRoot && !options.imposterExecutable)
    throw new Error('Copilot continuation requires the configured imposter executable');
  return {
    ...(parsed.data.imposterRoot
      ? {
          executable: options.imposterExecutable,
          env: {
            AI_PERSONA: 'copilot',
            COPILOT_HOME: parsed.data.home,
            PUPPETEER_IMPOSTER_HOME: parsed.data.imposterRoot,
          },
        }
      : {}),
    copilotHome: parsed.data.home,
  };
}
