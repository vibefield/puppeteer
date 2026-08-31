import type { AgentEvent } from '@vibecook/puppeteer-core';
import { antigravityNativeEvent } from './types.js';
export function normalizeAntigravityNative(type: string): AgentEvent[] {
  return [antigravityNativeEvent(type)];
}
