import {
  runAgentMonitorConformance,
  runAgentAdapterConformance,
  type AgentAdapterHarness,
} from '@vibecook/puppeteer-testing/conformance';
import { createAcpSession } from './driver.js';
import { scriptedAcpConnector } from './test-support/scripted-connector.js';
import type { AcpConnector } from './transport/connection.js';

const SID = '019f5e50-ce8b-7152-abcd-00000000c0de';
const REPLY = 'pong';

interface AcpHarness extends AgentAdapterHarness {
  closeObservationRail(): void;
}

async function acpHarness(resume?: string): Promise<AcpHarness> {
  let closed = false;
  let dropObservationRail = (): void => {
    throw new Error('ACP connector not initialized');
  };
  const base = scriptedAcpConnector({ sessionId: SID, reply: REPLY, ...(resume ? { historyReply: REPLY } : {}) });
  const connector: AcpConnector = (client) => {
    const connection = base(client);
    dropObservationRail = () => connection.close();
    return {
      ...connection,
      close: () => {
        closed = true;
        connection.close();
      },
    };
  };
  const session = await createAcpSession({
    cwd: '/x',
    connector,
    resume,
  });
  return {
    binding: session,
    reply: REPLY,
    resume: () => acpHarness(session.sessionId),
    assertNoOrphans: async () => {
      if (!closed) throw new Error('ACP connector survived dispose()');
    },
    closeObservationRail: () => dropObservationRail(),
    driveTurn: async () => {
      const done = new Promise<void>((resolve) => {
        const off = session.events.onCandidate((e) => {
          if (e.event.type === 'turn:completed') {
            off();
            resolve();
          }
        });
      });
      await session.services.prompt.submit({ text: 'go' });
      await done;
    },
  };
}

runAgentAdapterConformance('acp', acpHarness);
runAgentMonitorConformance('acp', async () => {
  const harness = await acpHarness();
  return { binding: harness.binding, closeObservationRail: harness.closeObservationRail };
});
