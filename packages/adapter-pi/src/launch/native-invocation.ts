import { resolve } from 'node:path';
import { readInvocation } from './invocation-grammar.js';
import { z } from 'zod';
import type { AgentNativeInvocation, AgentNativeInvocationResolution } from '@vibefield/puppeteer-core';

const SAFE_ID = /^[A-Za-z0-9._-]+$/u;
const REJECTED = 'custom arguments are not compatible with the managed Pi launch';
const StateSchema = z.strictObject({
  version: z.literal(1),
  agentDir: z.string().optional(),
  sessionDir: z.string(),
  imposterRoot: z.string().optional(),
});

export interface PiNativeInvocationOptions {
  executable?: string | undefined;
  env?: Record<string, string> | undefined;
  piAgentDir?: string | undefined;
  sessionDir?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  thinking?: string | undefined;
  name?: string | undefined;
}

export function normalizePiNativeInvocation(
  invocation: AgentNativeInvocation,
): AgentNativeInvocationResolution<PiNativeInvocationOptions> {
  if (invocation.providerId !== 'pi') return { status: 'rejected', reason: 'provider mismatch' };
  const reading = readInvocation(invocation.argv);
  if (reading.status !== 'accepted') return reading;
  const argv = reading.argv;
  let resume: string | undefined;
  const options: PiNativeInvocationOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const separator = argument.indexOf('=');
    const flag = separator < 0 ? argument : argument.slice(0, separator);
    const inlineValue = separator < 0 ? undefined : argument.slice(separator + 1);
    if (flag === '--session') {
      const value = inlineValue ?? argv[++index];
      if (resume || !value || value === '.' || value === '..' || value.startsWith('-') || !SAFE_ID.test(value))
        return { status: 'rejected', reason: REJECTED, argument };
      resume = value;
      continue;
    }
    const field =
      flag === '--provider'
        ? 'provider'
        : flag === '--model'
          ? 'model'
          : flag === '--thinking'
            ? 'thinking'
            : flag === '--name'
              ? 'name'
              : flag === '--session-dir'
                ? 'sessionDir'
                : undefined;
    const value = field ? (inlineValue ?? argv[++index]) : undefined;
    if (!field || !value || value.startsWith('-') || options[field] !== undefined)
      return { status: 'rejected', reason: REJECTED, argument };
    options[field] = field === 'sessionDir' ? resolve(invocation.cwd, value) : value;
  }
  const agentDir = invocation.environment.PI_CODING_AGENT_DIR;
  const sessionDir = invocation.environment.PI_CODING_AGENT_SESSION_DIR;
  if (agentDir) options.piAgentDir = resolve(invocation.cwd, agentDir);
  if (sessionDir && !options.sessionDir) options.sessionDir = resolve(invocation.cwd, sessionDir);
  if (invocation.implementation.kind === 'imposter') {
    const root = invocation.implementation.stateRoot;
    if (!root) return { status: 'rejected', reason: 'Pi imposter requires an isolated state root' };
    options.executable = invocation.implementation.executable;
    options.piAgentDir = root;
    options.sessionDir = resolve(root, 'sessions');
    options.env = {
      AI_PERSONA: 'pi',
      PI_CODING_AGENT_DIR: root,
      PI_CODING_AGENT_SESSION_DIR: options.sessionDir,
      PUPPETEER_IMPOSTER_HOME: root,
    };
  }
  return { status: 'accepted', ...(resume ? { resume } : {}), ...(Object.keys(options).length ? { options } : {}) };
}

export function capturePiContinuationState(
  options: PiNativeInvocationOptions | undefined,
  cwd: string,
): string | undefined {
  const sessionDir =
    options?.sessionDir ?? options?.env?.PI_CODING_AGENT_SESSION_DIR ?? process.env.PI_CODING_AGENT_SESSION_DIR;
  const agentDir = options?.piAgentDir ?? options?.env?.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR;
  const imposterRoot = options?.env?.PUPPETEER_IMPOSTER_HOME;
  if (!sessionDir) return undefined;
  return JSON.stringify({
    version: 1,
    ...(agentDir ? { agentDir: resolve(cwd, agentDir) } : {}),
    sessionDir: resolve(cwd, sessionDir),
    ...(imposterRoot ? { imposterRoot: resolve(cwd, imposterRoot) } : {}),
  });
}

export function restorePiContinuationState(
  state: string | undefined,
  options: { imposterExecutable?: string | undefined } = {},
): PiNativeInvocationOptions | undefined {
  if (!state) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(state);
  } catch (cause) {
    throw new Error('invalid Pi continuation state', { cause });
  }
  const parsed = StateSchema.safeParse(decoded);
  if (!parsed.success) throw new Error('invalid Pi continuation state', { cause: parsed.error });
  if (parsed.data.imposterRoot && !options.imposterExecutable)
    throw new Error('Pi continuation requires the configured imposter executable');
  return {
    ...(parsed.data.imposterRoot ? { executable: options.imposterExecutable } : {}),
    ...(parsed.data.agentDir ? { piAgentDir: parsed.data.agentDir } : {}),
    sessionDir: parsed.data.sessionDir,
    ...(parsed.data.imposterRoot
      ? {
          env: {
            AI_PERSONA: 'pi',
            PI_CODING_AGENT_DIR: parsed.data.imposterRoot,
            PI_CODING_AGENT_SESSION_DIR: parsed.data.sessionDir,
            PUPPETEER_IMPOSTER_HOME: parsed.data.imposterRoot,
          },
        }
      : {}),
  };
}
