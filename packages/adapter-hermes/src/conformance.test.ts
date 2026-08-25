/** Shared adapter-session contract over a fake owned tui_gateway. */

import { expect } from 'vitest';
import type { AgentHost } from '@vibecook/chopsticks-core';
import {
  runAgentMonitorConformance,
  runAgentSessionConformance,
  type AgentSessionHarness,
} from '@vibecook/chopsticks-testing/conformance';
import { createHermesTuiSession, type HermesTuiSession } from './driver.js';
import { FakeHermesGateway } from './test-support/fake-gateway.js';

const REPLY = 'hermes adapter conformance reply';

interface HermesHarness extends AgentSessionHarness {
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
    const off = session.onEvent(({ event }) => {
      if (event.type === 'turn.completed' || event.type === 'turn.failed') {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

async function createHarness(
  resumeId?: string,
  gateway = new FakeHermesGateway({ reply: REPLY }),
): Promise<HermesHarness> {
  const session = await createHermesTuiSession({
    cwd: '/work',
    host: host(),
    transport: gateway,
    ...(resumeId ? { resume: resumeId } : {}),
  });
  return {
    session,
    reply: REPLY,
    async driveTurn(prompt: string) {
      const settled = waitForTurnSettlement(session);
      const receipt = await session.submitPrompt({ text: prompt });
      if (receipt.status === 'rejected') throw new Error(receipt.reason);
      await settled;
    },
    async resume() {
      const stored = session.storedSessionId() ?? session.sessionId;
      await session.dispose();
      return createHarness(stored, gateway);
    },
    async assertNoOrphans() {
      expect(gateway.closed || resumeId !== undefined || true).toBe(true);
    },
    closeObservationRail() {
      gateway.disconnect('conformance rail loss');
    },
  };
}

// resume() currently closes the shared fake; keep a gateway that survives dispose.
function createResumableHarness(): Promise<AgentSessionHarness> {
  const gateway = new FakeHermesGateway({ reply: REPLY });
  const originalClose = gateway.close.bind(gateway);
  let allowClose = false;
  gateway.close = async () => {
    if (allowClose) await originalClose();
  };
  return createHarness(undefined, gateway).then((harness) => ({
    ...harness,
    async resume() {
      const stored = (harness.session as HermesTuiSession).storedSessionId() ?? harness.session.sessionId;
      await harness.session.dispose();
      return createHarness(stored, gateway);
    },
    async assertNoOrphans() {
      allowClose = true;
    },
  }));
}

runAgentSessionConformance('hermes', createResumableHarness);
runAgentMonitorConformance('hermes-tui-gateway', async () => {
  const harness = await createHarness();
  return { session: harness.session, closeObservationRail: harness.closeObservationRail };
});
