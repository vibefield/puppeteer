import type { AgentEvent } from '@vibefield/puppeteer-core';

export interface NormalizedUpdate {
  events: AgentEvent[];
}

/** Select the normalized events owned by one ACP category adapter. */
export type AcpEventOfType<Type extends AgentEvent['type']> = Extract<AgentEvent, { type: Type }>;
