import { resolve } from 'node:path';
import { readInvocation } from './invocation-grammar.js';
import { z } from 'zod';
import type { AgentNativeInvocation, AgentNativeInvocationResolution } from '@vibefield/puppeteer-core';

const SAFE_ID = /^[A-Za-z0-9._-]+$/u;
const REJECTED = 'custom arguments are not compatible with the managed Copilot launch';
const StateSchema = z.strictObject({ version: z.literal(1), home: z.string(), imposterRoot: z.string().optional() });
export interface CopilotNativeInvocationOptions {
  executable?: string | undefined;
  env?: Record<string, string> | undefined;
  copilotHome?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  mode?: 'interactive' | 'plan' | 'autopilot' | undefined;
  allowAll?: boolean | undefined;
  agent?: string | undefined;
  context?: string | undefined;
  name?: string | undefined;
}

export function normalizeCopilotNativeInvocation(
  invocation: AgentNativeInvocation,
): AgentNativeInvocationResolution<CopilotNativeInvocationOptions> {
  if (invocation.providerId !== 'copilot') return { status: 'rejected', reason: 'provider mismatch' };
  const reading = readInvocation(invocation.argv);
  if (reading.status !== 'accepted') return reading;
  const argv = reading.argv;
  let resume: string | undefined;
  const options: CopilotNativeInvocationOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const separator = argument.indexOf('=');
    const flag = separator < 0 ? argument : argument.slice(0, separator);
    const inlineValue = separator < 0 ? undefined : argument.slice(separator + 1);
    if (flag === '--resume' || flag === '-r') {
      const value = inlineValue ?? argv[++index];
      if (resume || !value || value === '.' || value === '..' || value.startsWith('-') || !SAFE_ID.test(value))
        return { status: 'rejected', reason: REJECTED, argument };
      resume = value;
      continue;
    }
    if (flag === '--allow-all' || flag === '--yolo') {
      if (inlineValue !== undefined || options.allowAll) return { status: 'rejected', reason: REJECTED, argument };
      options.allowAll = true;
      continue;
    }
    if (flag === '--plan') {
      if (inlineValue !== undefined || options.mode) return { status: 'rejected', reason: REJECTED, argument };
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
    const value = field ? (inlineValue ?? argv[++index]) : undefined;
    if (!field || !value || value.startsWith('-') || options[field] !== undefined)
      return { status: 'rejected', reason: REJECTED, argument };
    if (field === 'mode' && !['interactive', 'plan', 'autopilot'].includes(value))
      return { status: 'rejected', reason: REJECTED, argument };
    (options as Record<string, unknown>)[field] = value;
  }
  if (resume && options.name)
    return { status: 'rejected', argument: '--name', reason: 'the managed resume cannot rename an existing session' };
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
  options: { imposterExecutable?: string | undefined } = {},
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
