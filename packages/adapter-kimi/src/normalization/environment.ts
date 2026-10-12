import type { EnvironmentEvent } from '@vibefield/puppeteer-core';
import { kimiRecord, kimiString } from './types.js';

/** Kimi profile cwd facts -> normalized environment events. */
export function normalizeKimiEnvironment(type: string, body: Record<string, unknown>): EnvironmentEvent[] | undefined {
  if (type === 'profile.bind') {
    const currentCwd = kimiString(kimiRecord(body.environmentDisclosure)?.cwd);
    return currentCwd ? [{ type: 'environment:updated', currentCwd }] : [];
  }
  if (type === 'llm.request') return [];
  return undefined;
}
