import type { BuiltinAgentRuntime } from './types.js';
import { createBuiltinProviders, type BuiltinProviderOptions } from './providers.js';
import { createAgentRuntime, type AgentRuntimeOptions } from '@vibecook/puppeteer-runtime';

export interface BuiltinAgentRuntimeOptions extends Omit<AgentRuntimeOptions, 'providers'> {
  imposterExecutable?: BuiltinProviderOptions['imposterExecutable'];
  acpConnector?: BuiltinProviderOptions['acpConnector'];
  home?: BuiltinProviderOptions['home'];
}

/** Turn-key runtime containing every built-in provider behind one interface. */
export function createBuiltinAgentRuntime(options: BuiltinAgentRuntimeOptions): BuiltinAgentRuntime {
  const { imposterExecutable, acpConnector, home, ...runtimeOptions } = options;
  return createAgentRuntime({
    ...runtimeOptions,
    providers: createBuiltinProviders({
      imposterExecutable,
      acpConnector,
      home,
    }),
  });
}
