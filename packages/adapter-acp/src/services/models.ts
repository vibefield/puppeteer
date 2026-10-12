import { defineModelService, type AgentModelService } from '@vibefield/puppeteer-core';

/** ACP's configOptions belong to a session and are optional; discovery must not silently create one. */
export function createAcpModelService(): AgentModelService {
  return defineModelService({
    provider: { id: 'acp', label: 'ACP', discovery: 'session' },
    async discover() {
      return {
        status: 'requires-session',
        provider: 'acp',
        code: 'requires-session',
        message:
          'This ACP connection exposes model choices only through session configuration, when supported by its server.',
      };
    },
    toAgentOptions() {
      throw new Error('ACP model selection requires a session.');
    },
  });
}
