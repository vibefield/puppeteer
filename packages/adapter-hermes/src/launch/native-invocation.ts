import { resolve } from 'node:path';
import { readInvocation } from './invocation-grammar.js';
import { z } from 'zod';
import type { AgentNativeInvocation, AgentNativeInvocationResolution } from '@vibefield/puppeteer-core';

const SAFE_NATIVE_SESSION_ID = /^[A-Za-z0-9._-]+$/u;
const HermesContinuationStateSchema = z.strictObject({
  version: z.literal(1),
  home: z.string().trim().min(1).max(8_192),
});

export interface HermesNativeInvocationOptions {
  yolo?: boolean | undefined;
  hermesHome?: string | undefined;
}

/** Hermes owns gateway creation and native `--tui` attachment. */
export function normalizeHermesNativeInvocation(
  invocation: AgentNativeInvocation,
): AgentNativeInvocationResolution<HermesNativeInvocationOptions> {
  if (invocation.providerId !== 'hermes') return { status: 'rejected', reason: 'provider mismatch' };
  const reading = readInvocation(invocation.argv);
  if (reading.status !== 'accepted') return reading;
  const argv = reading.argv;
  if (invocation.implementation.kind === 'imposter') {
    return { status: 'rejected', reason: 'Hermes does not advertise a conformant pane imposter' };
  }
  let resume: string | undefined;
  const options: HermesNativeInvocationOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--resume') {
      const value = argv[index + 1];
      if (
        resume ||
        !value ||
        value === 'latest' ||
        value === '.' ||
        value === '..' ||
        !SAFE_NATIVE_SESSION_ID.test(value)
      ) {
        return { status: 'rejected', reason: 'the managed Hermes launch requires an exact session id', argument };
      }
      resume = value;
      index += 1;
      continue;
    }
    if (argument === '--yolo' && options.yolo === undefined) {
      options.yolo = true;
      continue;
    }
    return { status: 'rejected', reason: 'the managed Hermes launch requires an exact session id', argument };
  }
  const home = invocation.environment.HERMES_HOME;
  if (home) options.hermesHome = resolve(invocation.cwd, home);
  return {
    status: 'accepted',
    ...(resume ? { resume } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}

export function captureHermesContinuationState(
  home: unknown,
  environment: unknown,
  cwd: string,
  processEnvironment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnvironment =
    environment && typeof environment === 'object' ? (environment as Record<string, unknown>).HERMES_HOME : undefined;
  const value = typeof home === 'string' && home.trim() ? home : (fromEnvironment ?? processEnvironment.HERMES_HOME);
  return typeof value === 'string' && value.trim()
    ? JSON.stringify({ version: 1, home: resolve(cwd, value) })
    : undefined;
}

export function restoreHermesContinuationState(state: string | undefined): HermesNativeInvocationOptions | undefined {
  if (!state) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(state);
  } catch (cause) {
    throw new Error('invalid Hermes continuation state', { cause });
  }
  const parsed = HermesContinuationStateSchema.safeParse(decoded);
  if (!parsed.success) throw new Error('invalid Hermes continuation state', { cause: parsed.error });
  return { hermesHome: parsed.data.home };
}
