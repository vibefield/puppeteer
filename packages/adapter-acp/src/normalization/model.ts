import type { SessionConfigOption, SessionUpdate } from '@agentclientprotocol/sdk';
import type { AgentModelIdentity } from '@vibefield/puppeteer-core';
import type { AcpEventOfType } from './types.js';

type AcpModelEvent = AcpEventOfType<'model:updated' | 'adapter:native-event'>;

/** Resolve the active model only from ACP's semantic model config selector. */
export function acpModelIdentity(
  configOptions: readonly SessionConfigOption[] | null | undefined,
): AgentModelIdentity | undefined {
  const config = configOptions?.find((option) => option.type === 'select' && option.category === 'model');
  if (!config || config.type !== 'select' || !config.currentValue) return undefined;
  const choices = config.options.flatMap((option) => ('options' in option ? option.options : [option]));
  const selected = choices.find((option) => option.value === config.currentValue);
  return { id: config.currentValue, ...(selected?.name ? { displayName: selected.name } : {}) };
}

/** ACP model config changes -> Core model events. */
export function normalizeAcpModel(update: SessionUpdate): AcpModelEvent[] {
  if (update.sessionUpdate !== 'config_option_update') return [];
  const model = acpModelIdentity(update.configOptions);
  return model
    ? [{ type: 'model:updated', model }]
    : [{ type: 'adapter:native-event', adapter: 'acp', nativeType: update.sessionUpdate }];
}
