import type { AgentEvent } from '@vibecook/puppeteer-core';
import { copilotNativeEvent } from './types.js';
export function normalizeCopilotNative(type: string): AgentEvent[] {
  return [copilotNativeEvent(type)];
}
