import { existsSync, readFileSync } from 'node:fs';
import {
  runAgentMonitorConformance,
  runAgentSessionConformance,
  type AgentSessionHarness,
} from '@vibecook/chopsticks-testing/conformance';
import { createClaudeSession } from './driver.js';
import type { PreparedClaudeSession } from './launch/prepare.js';
import { createHookBridge, type HookBridge } from './observation/hook-bridge.js';

const REPLY = 'done!';

/** Build a live ClaudeSession driven through its real hook bridge (test-as-Claude). */
let runtimeCounter = 0;

interface ClaudeConformanceHarness extends AgentSessionHarness {
  closeObservationRail(): void;
}

async function claudeHarness(resume?: string): Promise<ClaudeConformanceHarness> {
  let prepared: PreparedClaudeSession | undefined;
  let closeObservationRail = (): void => {
    throw new Error('Claude hook bridge unavailable listener is not attached');
  };
  const session = await createClaudeSession({
    cwd: '/tmp',
    title: 'conformance',
    resume,
    ports: {
      spawn: async (p) => {
        prepared = p;
        return { runtimeSessionId: `rt-conformance-${++runtimeCounter}` };
      },
      automate: async () => ({ accepted: true }),
    },
    hookBridgeFactory: (options): HookBridge => {
      const bridge = createHookBridge(options);
      return {
        token: bridge.token,
        endpoint: () => bridge.endpoint(),
        statusLineEndpoint: () => bridge.statusLineEndpoint(),
        subagentStatusLineEndpoint: () => bridge.subagentStatusLineEndpoint(),
        start: () => bridge.start(),
        onEvent: (listener) => bridge.onEvent(listener),
        onStatusLine: (listener) => bridge.onStatusLine(listener),
        onSubagentStatusLine: (listener) => bridge.onSubagentStatusLine(listener),
        onUnavailable(listener) {
          closeObservationRail = () => listener('conformance hook rail loss');
          return bridge.onUnavailable(listener);
        },
        dispose: () => bridge.dispose(),
      };
    },
  });

  const settings = JSON.parse(readFileSync(prepared!.settingsPath, 'utf8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ url?: string }> }>>;
  };
  const endpoint = settings.hooks.UserPromptSubmit[0].hooks[0].url!;
  const token = prepared!.env.CHOPSTICKS_HOOK_TOKEN;

  const hook = async (name: string, fields: Record<string, unknown> = {}): Promise<void> => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ session_id: session.sessionId, cwd: '/tmp', hook_event_name: name, ...fields }),
    });
    if (res.status !== 200) throw new Error(`hook ${name} -> ${res.status}`);
  };

  await hook('SessionStart', {}); // -> ready, native-hooks
  if (resume) {
    // A resumed native session replays its durable transcript before new input.
    // This in-memory harness supplies the equivalent final historical message.
    await hook('Stop', { prompt_id: 'history', last_assistant_message: REPLY });
  }

  let turn = 0;
  return {
    session,
    reply: REPLY,
    resume: () => claudeHarness(session.sessionId),
    closeObservationRail: () => closeObservationRail(),
    assertNoOrphans: async () => {
      if (existsSync(prepared!.settingsPath)) throw new Error('Claude generated settings survived dispose()');
      if (existsSync(prepared!.hookForwarderPath)) throw new Error('Claude hook forwarder survived dispose()');
      let bridgeReachable = false;
      try {
        await fetch(endpoint, { method: 'POST' });
        bridgeReachable = true;
      } catch {
        // Expected: dispose closes the loopback hook bridge.
      }
      if (bridgeReachable) throw new Error('Claude hook bridge survived dispose()');
    },
    driveTurn: async (prompt) => {
      const promptId = `p-${++turn}`;
      await hook('UserPromptSubmit', { prompt, prompt_id: promptId });
      await hook('Stop', { prompt_id: promptId, last_assistant_message: REPLY });
    },
  };
}

runAgentSessionConformance('claude', claudeHarness);
runAgentMonitorConformance('claude-hooks', async () => {
  const harness = await claudeHarness();
  return { session: harness.session, closeObservationRail: harness.closeObservationRail };
});
