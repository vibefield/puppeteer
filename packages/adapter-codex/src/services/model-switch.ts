import {
  PUPPETEER_VERSION,
  type AgentModelSwitchReceipt,
  type AgentModelSwitchRequest,
  type AgentModelSwitchService,
} from '@vibefield/puppeteer-core';
import {
  AppServerClient,
  AppServerError,
  AppServerRequestTimeoutError,
  NO_REPLY,
  type Transport,
} from '../transport/app-server-client.js';

/**
 * A running Codex thread's model and reasoning effort, changed through the app-server the session already owns.
 *
 * Codex's TUI changes them in a picker (`/model`), which nothing here drives. The app-server takes the same change
 * as a request, `thread/settings/update {threadId, model}` or `{threadId, effort}`, "for subsequent turns", and tells
 * the thread's clients with `thread/settings/updated`. Read against codex-cli 0.171.0 in the isolated live rig
 * (`model-switch.live.test.ts`, 2026-11-22):
 *
 * - The request is behind `experimentalApi` (-32600 "thread/settings/update requires experimentalApi capability"
 *   without it), and the notification reaches only a subscribed connection that opted in: a second subscribed
 *   connection without it heard nothing. The observer's connection does not opt in, so this service holds one of
 *   its own that does, and hands what it hears to the observer (`CodexObserver.settingsUpdated`). That is also how a
 *   change the person makes in the TUI's own picker is observed.
 * - The TUI that joined the thread redraws its model and effort, and the next turn it starts is served by them.
 * - The profile's `config.toml` is not written, so the offer says `session`.
 * - The app-server checks neither word: an effort no model has was answered `{}`. So a word is held to a shape
 *   here, and a host offers only what the agent's own catalog lists (`services/models.ts`).
 *
 * The connection is subscribed to the thread, and the app-server sends a thread's requests (an approval, a
 * question) to every subscribed connection and acts on the first reply (`transport/app-server-client.ts`,
 * `NO_REPLY`). This one answers none of them.
 *
 * What Codex serves afterwards is its own `thread/settings/updated`, never this receipt.
 */

const CLIENT_INFO = { name: 'puppeteer-settings', version: PUPPETEER_VERSION } as const;
/** The id of the one control Codex's catalog gives a model (`services/models.ts`). */
const EFFORT_CONTROL = 'effort';
/** A model as Codex's catalog writes one: `gpt-5.1-codex-max`, or a provider's own name. */
const MODEL_WORD = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;
/** A reasoning effort as the catalog writes one: `low`, `xhigh`. */
const EFFORT_WORD = /^[a-z][a-z0-9-]{0,31}$/;

export interface CodexModelSwitchOptions {
  /** A new connection to the session's private app-server. */
  connect(): Transport;
  /** The observed thread, once one is. */
  threadId(): string | undefined;
  isDisposed(): boolean;
  /** The app-server's `thread/settings/updated` for the observed thread, as this connection heard it. */
  onSettings(params: Record<string, unknown>): void;
  requestTimeoutMs?: number | undefined;
}

export interface CodexModelSwitch extends AgentModelSwitchService {
  /**
   * Open the connection and subscribe to the thread now, so a change made in the TUI is heard before any is asked
   * for here. A failure is not kept: the next call, or the next `submit`, opens it again.
   */
  listen(): Promise<void>;
  dispose(): Promise<void>;
}

function changeFor(request: AgentModelSwitchRequest): { model: string } | { effort: string } | undefined {
  if (request.kind === 'model') return MODEL_WORD.test(request.modelId) ? { model: request.modelId } : undefined;
  if (request.controlId !== EFFORT_CONTROL) return undefined;
  return EFFORT_WORD.test(request.value) ? { effort: request.value } : undefined;
}

/** An app-server that does not serve the request to this connection: a later attempt cannot land either. */
function unserved(error: AppServerError): boolean {
  const { code, message } = error.body;
  if (code === -32601) return true;
  return code === -32600 && /requires experimentalApi capability|unknown variant|unknown method/iu.test(message);
}

function refusal(cause: unknown): AgentModelSwitchReceipt {
  if (cause instanceof AppServerError) {
    if (unserved(cause)) {
      return { status: 'rejected', reason: 'this Codex does not take a settings change', retryable: false };
    }
    return { status: 'rejected', reason: `Codex refused the change: ${cause.body.message.slice(0, 200)}` };
  }
  if (cause instanceof AppServerRequestTimeoutError) {
    return { status: 'rejected', reason: 'Codex did not answer the change' };
  }
  return { status: 'rejected', reason: cause instanceof Error ? cause.message : String(cause) };
}

export function createCodexModelSwitch(options: CodexModelSwitchOptions): CodexModelSwitch {
  let rail: Promise<AppServerClient> | undefined;
  let active = false;
  let closed = false;

  function open(): Promise<AppServerClient> {
    if (closed || options.isDisposed()) return Promise.reject(new Error('the agent binding is disposed'));
    if (rail) return rail;
    const threadId = options.threadId();
    if (!threadId) return Promise.reject(new Error('no Codex thread is attached yet'));
    const client = new AppServerClient(
      options.connect(),
      options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs },
    );
    // A subscribed connection is sent the thread's approvals and questions too. They are the person's, in the TUI.
    client.onServerRequest(() => NO_REPLY);
    client.onNotification((method, params) => {
      if (method !== 'thread/settings/updated' || !params) return;
      if (closed || options.isDisposed() || params.threadId !== options.threadId()) return;
      options.onSettings(params);
    });
    const opened = (async () => {
      await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } });
      client.notify('initialized');
      // Subscribes this connection to the thread, with none of its turns: only then does it hear the settings.
      await client.request('thread/resume', { threadId, excludeTurns: true });
      return client;
    })();
    rail = opened;
    const forget = (): void => {
      if (rail === opened) rail = undefined;
    };
    client.onClose(forget);
    opened.catch(() => {
      forget();
      void Promise.resolve(client.close()).catch(() => undefined);
    });
    return opened;
  }

  return {
    offer: { model: true, controls: [EFFORT_CONTROL], persistence: 'session' },
    async listen(): Promise<void> {
      await open();
    },
    async submit(request): Promise<AgentModelSwitchReceipt> {
      if (closed || options.isDisposed()) {
        return { status: 'rejected', reason: 'the agent binding is disposed', retryable: false };
      }
      const change = changeFor(request);
      if (change === undefined) {
        return {
          status: 'rejected',
          reason: 'not a model or an effort level Codex can be asked for',
          retryable: false,
        };
      }
      const threadId = options.threadId();
      if (!threadId) return { status: 'rejected', reason: 'no Codex thread is attached yet' };
      if (active) return { status: 'rejected', reason: 'another model switch is active' };
      active = true;
      try {
        const client = await open();
        await client.request('thread/settings/update', { threadId, ...change });
        return { status: 'sent' };
      } catch (cause) {
        if (closed || options.isDisposed()) {
          return { status: 'rejected', reason: 'the agent binding is disposed', retryable: false };
        }
        return refusal(cause);
      } finally {
        active = false;
      }
    },
    async dispose(): Promise<void> {
      if (closed) return;
      closed = true;
      const opened = rail;
      rail = undefined;
      if (!opened) return;
      try {
        await (await opened).close();
      } catch {
        // It never opened, or it is already closed: nothing is left to stop.
      }
    },
  };
}
