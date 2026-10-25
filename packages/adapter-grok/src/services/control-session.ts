import {
  type AdapterEventCandidate,
  type AgentAdapterBinding,
  type AgentEvent,
  type ObservationLevel,
  type PromptReceipt,
  type PromptSubmission,
} from '@vibefield/puppeteer-core';
import type { AdapterMonitorObservationBatch } from '@vibefield/puppeteer-core/monitor-spi';
import { GrokMonitorEvidence, type GrokConfiguredIntent } from '../normalization/monitor.js';
import type { GrokObservedEvent, GrokSessionObserver } from '../normalization/types.js';
import { GrokEventSource, type GrokEventPublication } from './event-source.js';

type Params = Record<string, unknown>;

function isRecord(value: unknown): value is Params {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** ACP params behind a control candidate: session/update params, or an extension's `{ method, params }`. */
function controlParams(nativeEvent: unknown): Params | undefined {
  if (!isRecord(nativeEvent)) return undefined;
  return typeof nativeEvent.method === 'string' && isRecord(nativeEvent.params) ? nativeEvent.params : nativeEvent;
}

/** Grok marks the history it replays over ACP during session/load with `_meta.isReplay`. */
function replayedByGrok(params: Params | undefined): boolean {
  return isRecord(params?._meta) && params._meta.isReplay === true;
}

/**
 * The leader forwards a subagent child session's traffic to the parent's
 * controller under the child's sessionId (Grok 1.0.0 and 1.0.70).
 */
function foreignSession(params: Params | undefined, sessionId: string): boolean {
  const id = params?.sessionId;
  return typeof id === 'string' && id !== '' && id !== sessionId;
}

/**
 * A Grok TUI session whose ACP control client attaches asynchronously. The TUI
 * is usable immediately; observation and prompt injection bind once attach
 * succeeds.
 */
export function createPendingControlSession(
  sessionId: string,
  runtimeSessionId: string,
  attach: () => AgentAdapterBinding | Promise<AgentAdapterBinding>,
  observer?: GrokSessionObserver,
  configured: GrokConfiguredIntent = {},
): AgentAdapterBinding {
  const events = new GrokEventSource(sessionId);
  let control: AgentAdapterBinding | undefined;
  let disposed = false;
  // TUI conversation and lifecycle are authoritative in Grok's persisted
  // structured log. ACP remains a control/approval side channel.
  let observation: ObservationLevel = observer ? 'native-log' : 'structured';
  const monitorEvidence = new GrokMonitorEvidence({ nativeSessionId: () => sessionId });
  let activeTurnId: string | undefined;
  let unsubscribeControl: (() => void) | undefined;
  let unsubscribeObserver: (() => void) | undefined;
  let unsubscribeObserverError: (() => void) | undefined;
  let controlDegraded = false;
  // Without configured hooks the durable log never records session_start, so
  // ACP's own session/new|load start is admitted; whichever rail reports a live
  // start first wins and later live starts of this binding are duplicates.
  let liveSessionStarted = false;

  function emitMonitorBatch(batch: AdapterMonitorObservationBatch | null): void {
    if (!batch) return;
    publish({ type: 'monitor:batch', batch }, { timestamp: batch.observedAt, source: 'native-protocol' });
  }

  const capabilitiesBatch = monitorEvidence.capabilitiesBatch(new Date().toISOString());
  emitMonitorBatch(capabilitiesBatch);
  emitMonitorBatch(monitorEvidence.configuredBatch(configured, new Date().toISOString()));

  function publish(event: AgentEvent, publication: GrokEventPublication = {}): void {
    events.publish(event, publication);
  }

  function applyObserved(observed: GrokObservedEvent, monitorAlreadyObserved = false): void {
    // A Grok session is durable across terminal attachments. Replaying the
    // previous pane's session_end would incorrectly terminate the newly
    // resumed binding before its live control rail can serve another turn.
    if (observed.phase === 'bootstrap' && observed.event.type === 'session:exited') return;
    if (observed.event.type === 'session:started' && observed.phase !== 'bootstrap') {
      if (liveSessionStarted) return;
      liveSessionStarted = true;
    }
    if (!monitorAlreadyObserved) {
      emitMonitorBatch(monitorEvidence.observedBatch(observed, observed.timestamp ?? new Date().toISOString()));
    }
    const observedTurnId =
      observed.promptId ??
      (observed.event.type === 'turn:started' ||
      observed.event.type === 'turn:completed' ||
      observed.event.type === 'turn:failed'
        ? observed.event.turnId
        : undefined);
    if (observed.event.type === 'turn:started') activeTurnId = observedTurnId;
    publish(observed.event, {
      promptId: observed.promptId,
      turnId: observedTurnId,
      timestamp: observed.timestamp,
      source: observed.source,
      confidence: observed.confidence,
      replay: observed.phase === 'bootstrap',
      nativeEvent: observed.nativeEvent,
    });
    if (observed.event.type === 'turn:completed' || observed.event.type === 'turn:failed') activeTurnId = undefined;
  }

  function degradeControl(error: unknown, code: 'grok-control-attach-failed' | 'grok-control-closed'): void {
    if (controlDegraded || disposed) return;
    controlDegraded = true;
    const message = error instanceof Error ? error.message : String(error);
    const timestamp = new Date().toISOString();
    publish(
      {
        type: 'adapter:native-event',
        adapter: 'grok',
        nativeType: 'control.unavailable',
        diagnostic: { code, message },
      },
      {
        timestamp,
        source: 'runtime',
        confidence: 'derived',
        nativeEvent: { code, message },
      },
    );
    if (!observer) observation = 'terminal-only';
    emitMonitorBatch(monitorEvidence.controlUnavailableBatch(timestamp, observer !== undefined));
  }

  function bindControl(acp: AgentAdapterBinding): AgentAdapterBinding | undefined {
    if (disposed) {
      void acp.dispose().catch(() => undefined);
      return undefined;
    }
    control = acp;
    unsubscribeControl = acp.events.onCandidate((candidate: AdapterEventCandidate) => {
      const params = controlParams(candidate.nativeEvent);
      const phase = candidate.replay || replayedByGrok(params) ? 'bootstrap' : 'live';
      if (candidate.event.type === 'monitor:batch') {
        applyObserved(
          {
            event: candidate.event,
            timestamp: candidate.timestamp,
            phase,
            source: candidate.source,
            confidence: candidate.confidence,
            nativeEvent: candidate.nativeEvent,
          },
          true,
        );
        return;
      }
      // A child session's turns, usage, and conversation are not this session's.
      // The monitor attributes a spawned child's usage and running turn to its
      // subagent actor and nothing to the root; otherwise only the child's raw
      // native events (they carry the child sessionId) are kept.
      const foreign = foreignSession(params, sessionId);
      emitMonitorBatch(monitorEvidence.controlCandidateBatch(candidate));
      if (foreign && candidate.event.type !== 'adapter:native-event') return;
      const acpTransportClosed =
        candidate.event.type === 'adapter:native-event' &&
        candidate.event.adapter === 'acp' &&
        candidate.event.nativeType === 'transport.closed';
      if (
        acpTransportClosed ||
        candidate.event.type === 'process:exited' ||
        candidate.event.type === 'session:exited'
      ) {
        degradeControl(new Error('Grok ACP control transport closed'), 'grok-control-closed');
        return;
      }
      // The native log owns TUI conversation and lifecycle. ACP remains the
      // live authority for host-side permissions and adds standard context
      // updates alongside the durable log's live context metadata.
      const allowedWithObserver = [
        'interaction:permission-requested',
        'interaction:permission-resolved',
        'context-window:updated',
        'context-window:invalidated',
        'environment:updated',
        'session:started',
      ];
      const liveNativeTruth = candidate.event.type === 'adapter:native-event' && candidate.event.adapter === 'grok';
      if (observer && !allowedWithObserver.includes(candidate.event.type) && !liveNativeTruth) return;
      applyObserved(
        {
          event: candidate.event,
          promptId: candidate.promptId ?? candidate.turnId ?? activeTurnId,
          timestamp: candidate.timestamp,
          phase,
          source: candidate.source,
          confidence: candidate.confidence,
          nativeEvent: candidate.nativeEvent,
        },
        true,
      );
    });
    applyObserved({
      event: { type: 'session:ready' },
      source: 'runtime',
      confidence: 'authoritative',
      nativeEvent: { code: 'grok-control-attached' },
    });
    return acp;
  }

  if (observer) {
    unsubscribeObserver = observer.onEvent(applyObserved);
    unsubscribeObserverError = observer.onError((error) => {
      applyObserved({
        event: { type: 'adapter:native-event', adapter: 'grok', nativeType: 'updates-log-error' },
        source: 'runtime',
        confidence: 'derived',
        nativeEvent: { message: error.message },
      });
    });
    // Start after listeners are wired. The async read gives the runtime time to
    // subscribe while still catching records written before terminal adoption.
    void observer.poll();
  }

  let controlReady: Promise<AgentAdapterBinding | undefined>;
  try {
    const attached = attach();
    if (typeof (attached as Promise<AgentAdapterBinding>).then === 'function') {
      controlReady = Promise.resolve(attached)
        .then(bindControl)
        .catch((error: unknown) => {
          degradeControl(error, 'grok-control-attach-failed');
          return undefined;
        });
    } else {
      controlReady = Promise.resolve(bindControl(attached as AgentAdapterBinding));
    }
  } catch (error) {
    degradeControl(error, 'grok-control-attach-failed');
    controlReady = Promise.resolve(undefined);
  }

  return {
    sessionId,
    runtimeSessionId,
    observationLevel: () => observation,
    events: {
      onCandidate(listener) {
        if (disposed) return () => undefined;
        return events.onCandidate(listener);
      },
    },
    services: {
      prompt: {
        async submit(submission: PromptSubmission): Promise<PromptReceipt> {
          const acp = control ?? (await controlReady.catch(() => undefined));
          if (!acp) return { status: 'rejected', reason: 'grok control client not attached' };
          return acp.services.prompt.submit(submission);
        },
      },
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeControl?.();
      unsubscribeObserver?.();
      unsubscribeObserverError?.();
      observer?.stop();
      events.close();
      if (control) await control.dispose().catch(() => undefined);
    },
  };
}
