import type { AgentEvent } from '@vibecook/puppeteer-core';
import { piNativeEvent } from './types.js';

export function normalizePiNative(type: string): AgentEvent[] {
  return [piNativeEvent(type)];
}
