import type { AgentAdapterBinding } from '@vibefield/puppeteer-core';
import { runAgentMonitorConformance } from '@vibefield/puppeteer-testing/conformance';
import { createPendingControlSession } from './driver.js';

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
    binding: session,
    async closeObservationRail() {
      control.reject(new Error('synthetic Grok control loss'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
});
