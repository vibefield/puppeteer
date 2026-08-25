/** Owned tui_gateway host + native `--tui` attach. Approvals stay native-TUI. */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  BufferedAgentEventSource,
  createEnvelopeStamper,
  type AgentEvent,
  type AgentEventEnvelope,
  type AgentAdapterSession,
  type AgentTuiSessionOptions,
  type PromptReceipt,
  type PromptSubmission,
  type TerminalSpec,
} from '@vibecook/puppeteer-core';
import type { AdapterMonitorObservationBatch } from '@vibecook/puppeteer-core/monitor-spi';
import { HERMES_ADAPTER_CAPABILITIES } from './detection.js';
import { startHermesGatewayHost, type HermesGatewayHost } from './launch/gateway-host.js';
import { buildHermesAttachLaunch } from './launch/recipe.js';
import { HermesMonitorEvidence } from './monitor-evidence.js';
import { HermesGatewayNormalizer } from './normalizer.js';
import {
  eventType,
  HermesJsonRpcClient,
  type HermesGatewayFrame,
  type HermesGatewayTransport,
} from './transport/jsonrpc.js';

export interface CreateHermesTuiSessionOptions extends AgentTuiSessionOptions {
  executable?: string;
  python?: string;
  hermesHome?: string;
  env?: Record<string, string>;
  yolo?: boolean;
  /** Connect to an already running owned gateway. Tests inject this. */
  gatewayUrl?: string;
  transport?: HermesGatewayTransport;
  promptConfirmationTimeoutMs?: number;
}

export interface HermesTuiSession extends AgentAdapterSession {
  gatewayUrl(): string | undefined;
  liveSessionId(): string | undefined;
  storedSessionId(): string | undefined;
}

export interface PreparedHermesTuiSession {
  readonly sessionId: string;
  readonly launch: TerminalSpec;
  adopt(runtimeSessionId: string): Promise<HermesTuiSession>;
  dispose(): Promise<void>;
}

interface HermesSessionResult {
  session_id?: string;
  stored_session_id?: string;
  resumed?: string;
  session_key?: string;
  messages?: Array<{ role?: string; text?: string; content?: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function prepareHermesTuiSession(
  options: CreateHermesTuiSessionOptions,
): Promise<PreparedHermesTuiSession> {
  const hermesHome = options.hermesHome ?? options.env?.HERMES_HOME ?? mkdtempSync(join(tmpdir(), 'puppeteer-hermes-'));
  let host: HermesGatewayHost | undefined;
  let transport = options.transport;
  let gatewayUrl = options.gatewayUrl;
  let disposed = false;

  try {
    if (!transport) {
      if (!gatewayUrl) {
        host = await startHermesGatewayHost({
          python: options.python,
          hermesHome,
          cwd: options.cwd,
          env: options.env,
        });
        gatewayUrl = host.url;
      }
      const client = new HermesJsonRpcClient(gatewayUrl);
      await client.connect();
      transport = client;
    }

    const buffered: HermesGatewayFrame[] = [];
    const stopBuffer = transport.onFrame((frame) => buffered.push(frame));
    const waitForEvent = (type: string, timeoutMs: number) =>
      new Promise<boolean>((resolve) => {
        if (buffered.some((frame) => eventType(frame) === type)) {
          resolve(true);
          return;
        }
        const timer = setTimeout(() => resolve(false), timeoutMs);
        const off = transport!.onFrame((frame) => {
          if (eventType(frame) === type) {
            clearTimeout(timer);
            off();
            resolve(true);
          }
        });
      });
    // Native tui_gateway announces before any request. Imposter serve emits
    // gateway.ready from session.start, which runs after session.create.
    await waitForEvent('gateway.ready', 250);

    const session = options.resume
      ? ((await transport.request('session.resume', {
          session_id: options.resume,
          cwd: options.cwd,
        })) as HermesSessionResult)
      : ((await transport.request('session.create', { cwd: options.cwd, source: 'tui' })) as HermesSessionResult);

    if (!(await waitForEvent('gateway.ready', 15_000))) {
      throw new Error('Hermes gateway.ready timed out');
    }
    await waitForEvent('session.info', 250);

    const liveSessionId = String(session.session_id ?? '');
    const storedSessionId = String(
      session.stored_session_id ?? session.resumed ?? session.session_key ?? liveSessionId,
    );
    if (!liveSessionId) throw new Error('Hermes session.create/resume returned no session_id');

    const launch = buildHermesAttachLaunch({
      executable: options.executable,
      cwd: options.cwd,
      hermesHome,
      gatewayUrl: gatewayUrl ?? 'ws://127.0.0.1/unused',
      resume: storedSessionId,
      yolo: options.yolo,
      env: options.env,
    });

    let adopted: HermesTuiSession | undefined;

    return {
      sessionId: storedSessionId,
      launch,
      async adopt(runtimeSessionId): Promise<HermesTuiSession> {
        if (disposed) throw new Error('prepared Hermes session is disposed');
        if (adopted) return adopted;
        const normalizer = new HermesGatewayNormalizer();
        normalizer.bindStoredSession(liveSessionId, storedSessionId);
        const stamper = createEnvelopeStamper();
        const events = new BufferedAgentEventSource();
        let sessionDisposed = false;
        let promptInFlight = false;
        let railAvailable = true;
        let promptStartWaiter: ((turnId: string | undefined) => void) | undefined;
        const monitorEvidence = new HermesMonitorEvidence({
          nativeSessionId: () => storedSessionId,
          liveSessionId: () => liveSessionId,
        });

        const publishEvent = (
          event: AgentEvent,
          meta: {
            nativeSessionId?: string;
            turnId?: string;
            timestamp: string;
            source: AgentEventEnvelope['source'];
            confidence: AgentEventEnvelope['confidence'];
            replay?: boolean;
            nativeEvent?: unknown;
          },
        ): void => {
          if (sessionDisposed) return;
          const envelope = stamper.next({
            sessionId: storedSessionId,
            nativeSessionId: meta.nativeSessionId ?? storedSessionId,
            ...(meta.turnId ? { turnId: meta.turnId } : {}),
            timestamp: meta.timestamp,
            monotonicTime: performance.now(),
            source: meta.source,
            confidence: meta.confidence,
            ...(meta.replay ? { replay: true } : {}),
            event,
            nativeEvent: meta.nativeEvent,
          });
          if (event.type === 'turn.started') promptStartWaiter?.(event.turnId ?? envelope.turnId);
          events.emit(envelope);
        };

        const emitMonitorBatch = (batch: AdapterMonitorObservationBatch | null): void => {
          if (!batch || sessionDisposed) return;
          publishEvent(
            { type: 'monitor.batch', batch },
            {
              timestamp: batch.observedAt,
              source: 'native-protocol',
              confidence: 'authoritative',
              nativeEvent: batch,
            },
          );
        };

        const capabilitiesBatch = monitorEvidence.capabilitiesBatch(new Date().toISOString());
        emitMonitorBatch(capabilitiesBatch);
        emitMonitorBatch(
          monitorEvidence.configuredBatch(
            { cwd: options.cwd, ...(options.yolo !== undefined ? { yolo: options.yolo } : {}) },
            new Date().toISOString(),
          ),
        );

        const publish = (observed: ReturnType<HermesGatewayNormalizer['normalize']>, replay = false): void => {
          if (sessionDisposed) return;
          for (const event of observed.events) {
            publishEvent(event, {
              nativeSessionId: observed.nativeSessionId,
              turnId: observed.turnId,
              timestamp: new Date().toISOString(),
              source: observed.source,
              confidence: observed.confidence,
              replay,
              nativeEvent: observed.nativeEvent,
            });
          }
        };
        const publishFrame = (
          frame: HermesGatewayFrame,
          replay = false,
          monitorPhase: 'bootstrap' | 'live' = replay ? 'bootstrap' : 'live',
        ): void => {
          emitMonitorBatch(monitorEvidence.recordBatch(frame, new Date().toISOString(), monitorPhase));
          publish(normalizer.normalize(frame), replay);
        };

        if (Array.isArray(session.messages)) {
          for (const message of session.messages) {
            if (message.role !== 'assistant') continue;
            const text = message.text ?? message.content;
            if (!text) continue;
            publishFrame(
              {
                method: 'event',
                params: {
                  type: 'message.complete',
                  session_id: liveSessionId,
                  payload: { text, status: 'complete' },
                },
              },
              true,
              'bootstrap',
            );
          }
        }

        let bootstrapping = true;
        const arrivedDuringBootstrap: HermesGatewayFrame[] = [];
        const off = transport!.onFrame((frame) => {
          if (bootstrapping) arrivedDuringBootstrap.push(frame);
          else publishFrame(frame);
        });
        const offStatus = transport!.onStatus?.((status) => {
          if (sessionDisposed) return;
          if (status.state === 'disconnected') {
            if (!railAvailable) return;
            railAvailable = false;
            emitMonitorBatch(
              monitorEvidence.railUnavailableBatch(
                new Date().toISOString(),
                status.reason ?? 'Hermes gateway observation disconnected',
              ),
            );
            return;
          }
          if (!railAvailable) {
            railAvailable = true;
            emitMonitorBatch(monitorEvidence.railReadyBatch(new Date().toISOString()));
          }
        });
        stopBuffer();
        for (const frame of buffered) publishFrame(frame, false, 'bootstrap');
        for (const frame of arrivedDuringBootstrap.splice(0)) publishFrame(frame, false, 'bootstrap');
        publish(normalizer.acknowledgeSession(storedSessionId));
        bootstrapping = false;

        const handle: HermesTuiSession = {
          get sessionId() {
            return storedSessionId;
          },
          runtimeSessionId,
          observationLevel: () =>
            sessionDisposed || !railAvailable ? 'terminal-only' : HERMES_ADAPTER_CAPABILITIES.observationLevel,
          gatewayUrl: () => gatewayUrl,
          liveSessionId: () => liveSessionId,
          storedSessionId: () => storedSessionId,
          onEvent(listener) {
            if (sessionDisposed) return () => undefined;
            return events.onEvent(listener);
          },
          async submitPrompt(submission: PromptSubmission): Promise<PromptReceipt> {
            if (sessionDisposed) return { status: 'rejected', reason: 'Hermes session is disposed' };
            if (submission.mode === 'paste-only') {
              return { status: 'rejected', reason: 'Hermes structured submit does not stage paste-only text' };
            }
            if (promptInFlight) return { status: 'rejected', reason: 'another Hermes prompt submission is in flight' };
            promptInFlight = true;
            const timeoutMs = submission.confirmationTimeoutMs ?? options.promptConfirmationTimeoutMs ?? 15_000;
            let cancelStartWait = (): void => undefined;
            const sawStart = new Promise<{ turnId?: string } | undefined>((resolve) => {
              let settled = false;
              const finish = (result: { turnId?: string } | undefined): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                promptStartWaiter = undefined;
                resolve(result);
              };
              const timer = setTimeout(() => finish(undefined), timeoutMs);
              promptStartWaiter = (turnId) => {
                finish(turnId ? { turnId } : {});
              };
              cancelStartWait = () => finish(undefined);
            });
            try {
              const result = await transport!.request('prompt.submit', {
                session_id: liveSessionId,
                text: submission.text,
              });
              if (!isRecord(result) || result.status !== 'streaming') {
                return { status: 'uncertain', reason: 'prompt.submit did not return streaming' };
              }
              const started = await sawStart;
              if (!started) {
                return { status: 'uncertain', reason: `no message.start within ${timeoutMs}ms` };
              }
              return { status: 'confirmed', ...started };
            } catch (error) {
              return { status: 'rejected', reason: error instanceof Error ? error.message : String(error) };
            } finally {
              cancelStartWait();
              promptInFlight = false;
            }
          },
          async dispose() {
            if (sessionDisposed) return;
            sessionDisposed = true;
            promptStartWaiter = undefined;
            off();
            offStatus?.();
            events.close();
            await transport?.close();
            await host?.close();
          },
        };
        adopted = handle;
        return handle;
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        await adopted?.dispose();
        await transport?.close();
        await host?.close();
      },
    };
  } catch (error) {
    await transport?.close();
    await host?.close();
    throw error;
  }
}

export async function createHermesTuiSession(options: CreateHermesTuiSessionOptions): Promise<HermesTuiSession> {
  const prepared = await prepareHermesTuiSession(options);
  try {
    const { runtimeSessionId } = await options.host.spawnTerminal(prepared.launch);
    return await prepared.adopt(runtimeSessionId);
  } catch (error) {
    await prepared.dispose();
    throw error;
  }
}
