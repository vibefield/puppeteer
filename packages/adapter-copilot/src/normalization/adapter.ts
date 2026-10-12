import type { AgentEvent } from '@vibefield/puppeteer-core';
import { copilotNativeEvent } from './types.js';
export function normalizeCopilotNative(type: string): AgentEvent[] {
  return [copilotNativeEvent(type)];
}
