import type { AgentEvent } from '@vibefield/puppeteer-core';
import { piNativeEvent } from './types.js';

export function normalizePiNative(type: string): AgentEvent[] {
  return [piNativeEvent(type)];
}
