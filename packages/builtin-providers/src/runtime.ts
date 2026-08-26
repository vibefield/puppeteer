import type { BuiltinAgentRuntime } from './types.js';
import { createBuiltinProviders, type BuiltinProviderOptions } from './providers.js';
import { createAgentRuntime, type AgentRuntimeOptions } from '@vibecook/puppeteer-runtime';

export interface BuiltinAgentRuntimeOptions extends Omit<AgentRuntimeOptions, 'providers'> {
  executables?: BuiltinProviderOptions['executables'];
  acpConnector?: BuiltinProviderOptions['acpConnector'];
  /** Native-canary-only Claude observation-rail fault injection. */
  claudeHookRailFaultInjection?: BuiltinProviderOptions['claudeHookRailFaultInjection'];
  /** Optional tap of authoritative Claude semantic batches. */
  onClaudeObservationBatch?: BuiltinProviderOptions['onClaudeObservationBatch'];
  onClaudeObservationError?: BuiltinProviderOptions['onClaudeObservationError'];
}

/** Turn-key runtime containing every built-in provider behind one interface. */
export function createBuiltinAgentRuntime(options: BuiltinAgentRuntimeOptions): BuiltinAgentRuntime {
  return createAgentRuntime({
    ...options,
    providers: createBuiltinProviders({
      executables: options.executables,
      acpConnector: options.acpConnector,
      claudeSubagentStatusObservation: options.features?.claudeSubagentStatusObservation ?? false,
      onClaudeObservationBatch: options.onClaudeObservationBatch,
      onClaudeObservationError: options.onClaudeObservationError,
      claudeHookRailFaultInjection: options.claudeHookRailFaultInjection,
    }),
  });
}
