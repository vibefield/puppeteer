import {
  createAcpSession,
  createStdioAcpConnector,
  type AcpAgentConnection,
  type CreateAcpSessionOptions,
} from '@vibefield/puppeteer-adapter-acp';
import { pickAgentBriefing, type AgentAdapterBinding } from '@vibefield/puppeteer-core';
import { grokExtensionEvents } from '../normalization/adapter.js';
import { grokDeferredApprovalEvidence } from '../normalization/interaction.js';
import type { CreateGrokSessionOptions } from '../types.js';

/**
 * Whether the native viewer joins the controller's leader session.
 *
 * Grok 1.0.70's leader routes a permission request to every attached client and
 * takes the first answer, and its viewer renders the request for the person.
 * With a viewer attached and no host handler, the controller therefore stays
 * silent and lets the person answer in Grok's TUI; an immediate deny would
 * pre-empt them (and, since 1.0.70 also asks before spawn_subagent, refuse every
 * managed subagent). With a host handler the person can still answer first in
 * the TUI, and Grok then ignores the host's reply; the same native evidence
 * publishes the person's answer and aborts the host request's `signal`.
 * Without a viewer nobody else can answer, so the controller keeps
 * adapter-acp's immediate deny rather than hang the turn.
 */
export interface GrokControlComposition {
  viewer: 'attached' | 'none';
  /** Hears every extension notification before normalization (services/briefed-servers.ts). */
  observeExtension?: ((method: string, params: Record<string, unknown>) => void) | undefined;
}

/** The Grok-specific ACP session options, apart from the transport and the session to load. */
export function grokControlOptions(
  options: Pick<
    CreateGrokSessionOptions,
    'clientCapabilities' | 'onApproval' | 'onElicitation' | 'mcpServers' | 'allowTools' | 'instructions'
  >,
  composition: GrokControlComposition = { viewer: 'none' },
): Omit<CreateAcpSessionOptions, 'cwd' | 'connector' | 'resume'> {
  return {
    ...pickAgentBriefing(options),
    clientCapabilities: options.clientCapabilities,
    onApproval: options.onApproval,
    unhandledApproval: composition.viewer === 'attached' ? 'defer' : 'deny',
    deferredApprovalEvidence: grokDeferredApprovalEvidence,
    onElicitation: options.onElicitation,
    onExtensionNotification: composition.observeExtension
      ? (method, params) => {
          composition.observeExtension?.(method, params);
          return grokExtensionEvents(method, params);
        }
      : grokExtensionEvents,
  };
}

/** Open ACP control through the shared leader, optionally loading a session. */
export function openGrokControl(
  executable: string,
  cwd: string,
  socketPath: string,
  sessionId: string | undefined,
  options: Pick<
    CreateGrokSessionOptions,
    'clientCapabilities' | 'onApproval' | 'onElicitation' | 'mcpServers' | 'allowTools' | 'instructions'
  >,
  env?: NodeJS.ProcessEnv,
  composition: GrokControlComposition = { viewer: 'none' },
): Promise<AgentAdapterBinding> {
  const args = ['agent', '--leader', '--leader-socket', socketPath, 'stdio'];
  return createAcpSession({
    cwd,
    connector: createStdioAcpConnector({ executable, args, cwd, env }),
    ...(sessionId ? { resume: sessionId } : {}),
    ...grokControlOptions(options, composition),
  });
}

/** How long one re-assert may take before its client is closed. The isolated rig's took about a quarter second. */
export const GROK_REASSERT_TIMEOUT_MS = 15_000;

export interface ReassertGrokServersOptions {
  /** The run's stop: the client is closed at once. */
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * One load of a running session that names a briefed run's servers, by a client of the run's own leader that leaves at
 * once (services/briefed-servers.ts, 2026-11-24). It sends no `_meta`; whether a load without it changes the
 * session's agent or modes is not checked. Its replay of the session is nobody's to read.
 *
 * It never answers a permission request. The leader shows a client that joins a request still open (1.0.70 probe),
 * and the person answers it in the viewer; a reply from this client could be the first one the leader takes. So its
 * decision never settles, nothing is tracked for its dispose to release, and the leader sees the client leave rather
 * than an answer. Whether the leader keeps such a request open for the viewer after a client that was shown it leaves
 * is not observed. It advertises no elicitation, as the measured client did not.
 */
export async function reassertGrokServers(
  executable: string,
  cwd: string,
  socketPath: string,
  sessionId: string,
  mcpServers: NonNullable<CreateGrokSessionOptions['mcpServers']>,
  env?: NodeJS.ProcessEnv,
  options: ReassertGrokServersOptions = {},
): Promise<void> {
  const args = ['agent', '--leader', '--leader-socket', socketPath, 'stdio'];
  const connect = createStdioAcpConnector({ executable, args, cwd, env });
  let connection: AcpAgentConnection | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onStop: (() => void) | undefined;
  // A load that never answers, or a run that stops, closes the client; its pending requests then fail.
  const ended = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Grok server re-assert timed out')),
      options.timeoutMs ?? GROK_REASSERT_TIMEOUT_MS,
    );
    onStop = () => reject(new Error('Grok server re-assert stopped with its run'));
    if (options.signal?.aborted) onStop();
    else options.signal?.addEventListener('abort', onStop, { once: true });
  });
  ended.catch(() => undefined);
  const loading = createAcpSession({
    cwd,
    connector: (toClient) => (connection = connect(toClient)),
    resume: sessionId,
    mcpServers,
    onApproval: () => new Promise<never>(() => undefined),
    unhandledApproval: 'deny',
  });
  try {
    const loaded = await Promise.race([loading, ended]);
    await loaded.dispose();
  } finally {
    clearTimeout(timer);
    if (onStop) options.signal?.removeEventListener('abort', onStop);
    await connection?.close();
    // A load that answers after the client was closed is disposed too (dispose is idempotent).
    void loading.then(
      (late) => late.dispose(),
      () => undefined,
    );
  }
}
