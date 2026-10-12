import type { AgentEvent } from '@vibefield/puppeteer-core';

export function normalizeClaudeNativeEvent(nativeType: string): AgentEvent {
  return { type: 'adapter:native-event', adapter: 'claude-code', nativeType };
}
