import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { AcpEventOfType } from './types.js';

type AcpContextWindowEvent = AcpEventOfType<'context-window.updated' | 'adapter.native-event'>;

/** ACP context occupancy → provider-neutral context-window event adapter. */
export function normalizeAcpContextWindow(update: SessionUpdate): AcpContextWindowEvent[] {
  if (update.sessionUpdate !== 'usage_update') return [];
  if (
    typeof update.used === 'number' &&
    Number.isFinite(update.used) &&
    update.used >= 0 &&
    typeof update.size === 'number' &&
    Number.isFinite(update.size) &&
    update.size > 0
  ) {
    return [{ type: 'context-window.updated', usedTokens: update.used, capacityTokens: update.size }];
  }
  return [{ type: 'adapter.native-event', adapter: 'acp', nativeType: update.sessionUpdate }];
}
