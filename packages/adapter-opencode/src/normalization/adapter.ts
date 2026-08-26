import type { AgentEvent } from '@vibecook/puppeteer-core';

const FILTERED_INFRASTRUCTURE = new Set([
  'server.connected',
  'server.heartbeat',
  'plugin.added',
  'catalog.updated',
  'integration.updated',
  'integration.connection.updated',
  'reference.updated',
  'models-dev.refreshed',
  'session.diff',
]);

export function isFilteredOpenCodeInfrastructure(nativeType: string): boolean {
  return FILTERED_INFRASTRUCTURE.has(nativeType);
}

export function normalizeOpenCodeNativeEvent(nativeType: string): AgentEvent {
  return { type: 'adapter:native-event', adapter: 'opencode', nativeType };
}
