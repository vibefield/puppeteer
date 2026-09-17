import type { AgentEventSource } from '../events/contract.js';

/** This is a usage-source allowlist, not a conversation-observation policy. */
export function liveUsageOrigin(source: AgentEventSource): 'telemetry' | 'protocol' | 'hook' | undefined {
  switch (source) {
    case 'native-telemetry':
      return 'telemetry';
    case 'native-protocol':
      return 'protocol';
    case 'native-hook':
      return 'hook';
    default:
      return undefined;
  }
}

export function permitsLiveUsage(phase: string, origin: string | undefined): boolean {
  return (
    (phase === 'live' || phase === 'correction') &&
    (origin === 'telemetry' || origin === 'protocol' || origin === 'hook')
  );
}
