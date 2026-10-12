import type { AgentEvent } from '@vibefield/puppeteer-core';
import { antigravityNativeEvent } from './types.js';
export function normalizeAntigravityNative(type: string): AgentEvent[] {
  return [antigravityNativeEvent(type)];
}
