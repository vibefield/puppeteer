import {
  type AdapterEventCandidate,
  type AgentAdapterBinding,
  type AgentEvent,
  type ObservationLevel,
  type PromptReceipt,
  type PromptSubmission,
} from '@vibecook/puppeteer-core';
import type { AdapterMonitorObservationBatch } from '@vibecook/puppeteer-core/monitor-spi';
import { GrokMonitorEvidence, type GrokConfiguredIntent } from '../monitor-evidence.js';
import type { GrokObservedEvent, GrokSessionObserver } from '../session-observer.js';
import { GrokEventSource, type GrokEventPublication } from './event-source.js';

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
  let protocolContextAvailable = false;
  let controlDegraded = false;

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
    if (
      protocolContextAvailable &&
      observed.source === 'native-log' &&
      observed.event.type.startsWith('context-window:')
    ) {
      return;
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
      if (candidate.event.type === 'monitor:batch') {
        applyObserved(
          {
            event: candidate.event,
            timestamp: candidate.timestamp,
            phase: candidate.replay ? 'bootstrap' : 'live',
            source: candidate.source,
            confidence: candidate.confidence,
            nativeEvent: candidate.nativeEvent,
          },
          true,
        );
        return;
      }
      emitMonitorBatch(monitorEvidence.controlCandidateBatch(candidate));
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
      // live authority for host-side permissions and standard context usage.
      const allowedWithObserver = [
        'interaction:permission-requested',
        'interaction:permission-resolved',
        'context-window:updated',
        'context-window:invalidated',
        'environment:updated',
      ];
      const liveNativeTruth = candidate.event.type === 'adapter:native-event' && candidate.event.adapter === 'grok';
      if (observer && !allowedWithObserver.includes(candidate.event.type) && !liveNativeTruth) return;
      if (candidate.event.type.startsWith('context-window:')) protocolContextAvailable = true;
      applyObserved(
        {
          event: candidate.event,
          promptId: candidate.promptId ?? candidate.turnId ?? activeTurnId,
          timestamp: candidate.timestamp,
          phase: candidate.replay ? 'bootstrap' : 'live',
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
