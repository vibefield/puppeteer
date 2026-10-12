import type { AgentEvent } from '@vibefield/puppeteer-core';
import { hermesNativeEvent } from './types.js';

const RETAINED_HERMES_EVENTS = new Set([
  'gateway.ready',
  'sessions.changed',
  'thinking.delta',
  'reasoning.available',
  'tool.generating',
]);

export function isRetainedHermesEvent(type: string): boolean {
  return RETAINED_HERMES_EVENTS.has(type);
}

/** Preserve Hermes-native evidence that has no stable Core semantics. */
export function normalizeHermesNative(type: string): AgentEvent[] {
  return [hermesNativeEvent(type)];
}
