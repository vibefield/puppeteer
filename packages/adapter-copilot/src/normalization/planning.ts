import type { AgentEvent } from '@vibecook/puppeteer-core';
import { normalizeCopilotNative } from './adapter.js';

/**
 * The durable event proves that Copilot changed plan.md, but carries only the
 * mutation operation. Publishing an empty portable plan would incorrectly
 * mean "the plan has no steps", so retain the native fact until the separate
 * replace-in-place plan document is observed atomically.
 */
export function normalizeCopilotPlanning(type: string): AgentEvent[] | undefined {
  return type === 'session.plan_changed' ? normalizeCopilotNative(type) : undefined;
}
