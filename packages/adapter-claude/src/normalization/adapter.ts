import type { AgentEvent } from '@vibecook/puppeteer-core';

export function normalizeClaudeNativeEvent(nativeType: string): AgentEvent {
  return { type: 'adapter:native-event', adapter: 'claude-code', nativeType };
}
