import type { BuiltinAgentRuntime } from './types.js';
import { createBuiltinProviders, type BuiltinProviderOptions } from './providers.js';
import { createAgentRuntime } from './runtime.js';
import type { AgentRuntimeOptions } from './types.js';

export interface BuiltinAgentRuntimeOptions extends Omit<AgentRuntimeOptions, 'providers'> {
  executables?: BuiltinProviderOptions['executables'];
  acpConnector?: BuiltinProviderOptions['acpConnector'];
  /** Native-canary-only Claude observation-rail fault injection. */
  claudeHookRailFaultInjection?: BuiltinProviderOptions['claudeHookRailFaultInjection'];
  /** Optional tap of authoritative Claude semantic batches. */
  onClaudeScopedObservationBatch?: BuiltinProviderOptions['onClaudeScopedObservationBatch'];
  onClaudeScopedObservationDiagnostic?: BuiltinProviderOptions['onClaudeScopedObservationDiagnostic'];
  onClaudeScopedObservationError?: BuiltinProviderOptions['onClaudeScopedObservationError'];
}

/** Turn-key runtime containing every built-in provider behind one interface. */
export function createBuiltinAgentRuntime(options: BuiltinAgentRuntimeOptions): BuiltinAgentRuntime {
  return createAgentRuntime({
    ...options,
    providers: createBuiltinProviders({
      executables: options.executables,
      acpConnector: options.acpConnector,
      claudeSubagentStatusObservation: options.features?.claudeSubagentStatusObservation ?? false,
      onClaudeScopedObservationBatch: options.onClaudeScopedObservationBatch,
      onClaudeScopedObservationDiagnostic: options.onClaudeScopedObservationDiagnostic,
      onClaudeScopedObservationError: options.onClaudeScopedObservationError,
      claudeHookRailFaultInjection: options.claudeHookRailFaultInjection,
    }),
  });
}
