import type { AgentAdapterBinding } from '@vibecook/puppeteer-core';
import { runAgentMonitorConformance } from '@vibecook/puppeteer-testing/conformance';
import { createPendingControlSession } from './backend.js';

function deferred<T>() {
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((_resolve, rej) => {
    reject = rej;
  });
  return { promise, reject };
}

runAgentMonitorConformance('grok', async () => {
  const control = deferred<AgentAdapterBinding>();
  const session = createPendingControlSession('grok-conformance', 'runtime-conformance', () => control.promise);
  return {
    session,
    async closeObservationRail() {
      control.reject(new Error('synthetic Grok control loss'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
});
