import type { AgentEvent } from '@vibecook/puppeteer-core';
export function antigravityAssistantMessage(step: string, turnId: string, text: string): AgentEvent {
  return { type: 'conversation:assistant-message', messageId: `planner:${step}`, turnId, text, final: true };
}
