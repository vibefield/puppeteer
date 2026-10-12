/** Shared adapter-binding contract over a fake owned tui_gateway. */

import { expect } from 'vitest';
import type { AgentHost } from '@vibefield/puppeteer-core';
import {
  runAgentMonitorConformance,
  runAgentAdapterConformance,
  type AgentAdapterHarness,
} from '@vibefield/puppeteer-testing/conformance';
import { createHermesTuiSession } from './driver.js';
import {
  createFakeHermesGatewayState,
  FakeHermesGateway,
  type FakeHermesGatewayState,
} from './test-support/fake-gateway.js';

const REPLY = 'hermes adapter conformance reply';

interface HermesHarness extends AgentAdapterHarness {
  closeObservationRail(): void;
}

function host(): AgentHost {
  return {
    async spawnTerminal() {
      return { runtimeSessionId: `term-${Math.random().toString(16).slice(2)}` };
    },
    async automateTerminal() {
      return { accepted: true };
    },
  };
}

function waitForTurnSettlement(session: Awaited<ReturnType<typeof createHermesTuiSession>>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('turn did not settle')), 2_000);
    const off = session.events.onCandidate(({ event }) => {
      if (event.type === 'turn:completed' || event.type === 'turn:failed') {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

async function createHarness(
  resumeId?: string,
  state: FakeHermesGatewayState = createFakeHermesGatewayState(),
): Promise<HermesHarness> {
  const gateway = new FakeHermesGateway({ reply: REPLY, state });
  const session = await createHermesTuiSession({
    cwd: '/work',
    host: host(),
    transport: gateway,
    ...(resumeId ? { resume: resumeId } : {}),
  });
  return {
    binding: session,
    reply: REPLY,
    resumeHistory: 'identity-only',
    async driveTurn(prompt: string) {
      const settled = waitForTurnSettlement(session);
      const receipt = await session.services.prompt.submit({ text: prompt });
      if (receipt.status === 'rejected') throw new Error(receipt.reason);
      await settled;
    },
    async resume() {
      const stored = session.storedSessionId() ?? session.sessionId;
      return createHarness(stored, state);
    },
    async assertNoOrphans() {
      expect(gateway.closed).toBe(true);
    },
    closeObservationRail() {
      gateway.disconnect('conformance rail loss');
    },
  };
}

runAgentAdapterConformance('hermes', createHarness);
runAgentMonitorConformance('hermes-tui-gateway', async () => {
  const harness = await createHarness();
  return { binding: harness.binding, closeObservationRail: harness.closeObservationRail };
});
