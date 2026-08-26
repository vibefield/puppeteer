import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { AcpEventOfType } from './types.js';

type AcpFallbackEvent = AcpEventOfType<'adapter:native-event'>;

/** Preserve unmodeled ACP updates without inventing stable Core semantics. */
export function normalizeAcpFallback(update: SessionUpdate): AcpFallbackEvent[] {
  return [{ type: 'adapter:native-event', adapter: 'acp', nativeType: update.sessionUpdate }];
}
