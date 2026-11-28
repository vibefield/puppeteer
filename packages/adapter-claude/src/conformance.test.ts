import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runAgentMonitorConformance,
  runAgentAdapterConformance,
  type AgentAdapterHarness,
  type AgentProvisionalHarness,
} from '@vibefield/puppeteer-testing/conformance';
import { createClaudeSession, type ClaudeSession } from './driver.js';
import type { PreparedClaudeSession } from './launch/prepare.js';
import { createHookBridge, type HookBridge } from './observation/hook-bridge.js';

const REPLY = 'done!';

/** Build a live ClaudeSession driven through its real hook bridge (test-as-Claude). */
let runtimeCounter = 0;
/** An isolated Claude config root: a resume is refused unless the conversation is on disk under it. */
const configRoot = mkdtempSync(join(tmpdir(), 'claude-conformance-config-'));

interface ClaudeConformanceHarness extends AgentAdapterHarness {
  closeObservationRail(): void;
}

interface ClaudeLaunch {
  session: ClaudeSession;
  prepared: PreparedClaudeSession;
  endpoint: string;
  closeObservationRail(): void;
  /** One hook as Claude posts it, under `session_id` (default: the session the run observes); the bridge's status. */
  post(name: string, fields?: Record<string, unknown>): Promise<number>;
}

async function launch(options: { resume?: string; resumeInvocation?: string[] } = {}): Promise<ClaudeLaunch> {
  let prepared: PreparedClaudeSession | undefined;
  let closeObservationRail = (): void => {
    throw new Error('Claude hook bridge unavailable listener is not attached');
  };
  const session = await createClaudeSession({
    cwd: '/tmp',
    title: 'conformance',
    ...options,
    configDir: configRoot,
    ports: {
      spawn: async (p) => {
        prepared = p;
        return { runtimeSessionId: `rt-conformance-${++runtimeCounter}` };
      },
      automate: async () => ({ accepted: true }),
    },
    hookBridgeFactory: (bridgeOptions): HookBridge => {
      const bridge = createHookBridge(bridgeOptions);
      return {
        token: bridge.token,
        endpoint: () => bridge.endpoint(),
        statusLineEndpoint: () => bridge.statusLineEndpoint(),
        subagentStatusLineEndpoint: () => bridge.subagentStatusLineEndpoint(),
        otelLogsEndpoint: () => bridge.otelLogsEndpoint(),
        start: () => bridge.start(),
        onEvent: (listener) => bridge.onEvent(listener),
        onStatusLine: (listener) => bridge.onStatusLine(listener),
        onSubagentStatusLine: (listener) => bridge.onSubagentStatusLine(listener),
        onOtelLogs: (listener) => bridge.onOtelLogs(listener),
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
  const endpoint = settings.hooks.UserPromptSubmit![0]!.hooks[0]!.url!;
  const token = prepared!.env.PUPPETEER_HOOK_TOKEN;
  const post = async (name: string, fields: Record<string, unknown> = {}): Promise<number> => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ session_id: session.sessionId, cwd: '/tmp', hook_event_name: name, ...fields }),
    });
    return res.status;
  };
  return { session, prepared: prepared!, endpoint, closeObservationRail: () => closeObservationRail(), post };
}

/** A launch through Claude's own picker: it runs under a minted id until the conversation chosen in it holds. */
async function pickerHarness(): Promise<AgentProvisionalHarness> {
  const { session, post } = await launch({ resumeInvocation: ['--resume'] });
  const chosen = randomUUID();
  const expectOk = async (name: string, fields: Record<string, unknown>): Promise<void> => {
    const status = await post(name, { session_id: chosen, ...fields });
    if (status !== 200) throw new Error(`hook ${name} -> ${status}`);
  };
  return {
    binding: session,
    // the picker starts the chosen conversation, as it starts one it only previews
    bind: async () => {
      await expectOk('SessionStart', { source: 'resume' });
      return chosen;
    },
    // the chosen session's first hook of its own: on the picker's path, the person's first prompt in it
    hold: () => expectOk('UserPromptSubmit', { prompt: 'the first words in the chosen one', prompt_id: 'p-held' }),
  };
}

async function claudeHarness(resume?: string): Promise<ClaudeConformanceHarness> {
  if (resume) {
    // This harness never writes a transcript; the resume pre-flight wants one on disk.
    const project = join(configRoot, 'projects', '-tmp');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${resume}.jsonl`), '');
  }
  const { session, prepared, endpoint, closeObservationRail, post } = await launch(resume ? { resume } : {});
  const hook = async (name: string, fields: Record<string, unknown> = {}): Promise<void> => {
    const status = await post(name, fields);
    if (status !== 200) throw new Error(`hook ${name} -> ${status}`);
  };

  await hook('SessionStart', {}); // -> ready, native-hooks

  let turn = 0;
  return {
    binding: session,
    reply: REPLY,
    resume: () => claudeHarness(session.sessionId),
    resumeHistory: 'identity-only',
    closeObservationRail,
    assertNoOrphans: async () => {
      if (existsSync(prepared.settingsPath)) throw new Error('Claude generated settings survived dispose()');
      if (prepared.forwarderPath !== undefined && existsSync(prepared.forwarderPath)) {
        throw new Error('Claude forwarder survived dispose()');
      }
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
    // `/clear`: Claude ends the session and starts a new one in the same pane
    rotate: async () => {
      const next = randomUUID();
      await hook('SessionEnd', { reason: 'clear' });
      await hook('SessionStart', { session_id: next, source: 'clear' });
      return next;
    },
    // `/fork`: a copy starts in the background under its own id while the pane stays; the bridge refuses the copy
    fork: async () => {
      const copy = randomUUID();
      const status = await post('SessionStart', { session_id: copy, source: 'fork' });
      if (status !== 403) throw new Error(`a fork's start -> ${status}, where the bridge refuses it`);
      return copy;
    },
    provisional: pickerHarness,
  };
}

runAgentAdapterConformance('claude', claudeHarness, { moves: ['rotate', 'fork', 'provisional'] });
runAgentMonitorConformance('claude-hooks', async () => {
  const harness = await claudeHarness();
  return { binding: harness.binding, closeObservationRail: harness.closeObservationRail };
});
