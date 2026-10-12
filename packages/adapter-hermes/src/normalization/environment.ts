import type { EnvironmentEvent } from '@vibefield/puppeteer-core';
import { hermesString } from './types.js';

/** Hermes session.info → environment event. */
export function normalizeHermesEnvironment(payload: Record<string, unknown>): EnvironmentEvent[] {
  const currentCwd = hermesString(payload.cwd);
  return currentCwd ? [{ type: 'environment:updated', currentCwd }] : [];
}
