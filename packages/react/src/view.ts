import type { ComponentType } from 'react';
import type { AgentMonitorState } from '@vibecook/puppeteer-core';

/** Minimal input shared by monitor renderers; products may use richer item projections. */
export interface AgentMonitorViewProps<
  Item = AgentMonitorState,
  Actions = Readonly<Record<string, never>>,
  Parameters = Readonly<Record<string, never>>,
> {
  agents: readonly Item[];
  actions: Actions;
  parameters: Parameters;
}

/**
 * Portable monitor-view plugin contract.
 *
 * A view receives data and actions only. It does not know about runtimes,
 * adapters, IPC, terminals, or how monitor state reached the product.
 */
export interface AgentMonitorViewDefinition<
  Item = AgentMonitorState,
  Actions = Readonly<Record<string, never>>,
  Parameters = Readonly<Record<string, never>>,
> {
  readonly id: string;
  readonly label: string;
  readonly Component: ComponentType<AgentMonitorViewProps<Item, Actions, Parameters>>;
}
