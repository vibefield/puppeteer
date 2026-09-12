import type { MonitorArtifactReadResult } from '@vibecook/puppeteer-core';
import type { AdapterMonitorObservationBatch, ObservationCapability } from '@vibecook/puppeteer-core/monitor-spi';
import type {
  SemanticObservationAttachRequest,
  SemanticObservationEvent,
  SemanticObservationHandle,
  SemanticObservationPollHint,
  SemanticObservationProvider,
} from '../semantic-provider.js';
import { claudeTranscriptConversationFingerprint, projectClaudeTranscriptAssistants } from './conversation.js';
import { projectClaudeTranscriptModel } from './model.js';
import {
  createClaudeSessionTranscriptReader,
  type ClaudeSessionTranscriptSnapshot,
} from './services/session-reader.js';
import { createTranscriptYield } from './services/yield.js';

const DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS = 1_000;

function notify<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(value);
    } catch {
      // Observers are isolated from transcript polling and from each other.
    }
  }
}

function unavailableArtifact(artifactId: string): MonitorArtifactReadResult {
  return { status: 'unavailable', message: `Claude transcript observer does not expose artifact ${artifactId}` };
}

function retainMapKeys<Key, Value>(map: Map<Key, Value>, active: ReadonlySet<Key>): void {
  for (const key of map.keys()) {
    if (!active.has(key)) map.delete(key);
  }
}

export class ClaudeTranscriptObservationProvider implements SemanticObservationProvider {
  capabilities(): Promise<readonly ObservationCapability[]> {
    return Promise.resolve([]);
  }

  attach(request: SemanticObservationAttachRequest): Promise<SemanticObservationHandle> {
    const eventListeners = new Set<(event: SemanticObservationEvent) => void>();
    const batchListeners = new Set<(batch: AdapterMonitorObservationBatch) => void>();
    const errorListeners = new Set<(error: Error) => void>();
    const assistantFingerprints = new Map<string, string>();
    const modelFingerprints = new Map<string | undefined, string>();
    let lastTranscript: ClaudeSessionTranscriptSnapshot | undefined;
    let firstTranscriptPoll = true;
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let activePoll: Promise<void> | undefined;
    let pendingPoll: Promise<void> | undefined;
    const transcriptReader = createClaudeSessionTranscriptReader(request.transcriptPath, request.nativeSessionId);

    const emitEvent = (value: SemanticObservationEvent): void => notify(eventListeners, value);

    const projectTranscript = async (): Promise<void> => {
      const records = await transcriptReader.read();
      if (disposed || records === lastTranscript) return;
      const yieldIfNeeded = createTranscriptYield();
      const pending: SemanticObservationEvent[] = [];
      const assistants = projectClaudeTranscriptAssistants(records.root);

      // Existing messages form a silent baseline on every attachment,
      // including picker rebinds. Only later changes are live observations.
      for (const [key, event] of assistants) {
        const fingerprint = claudeTranscriptConversationFingerprint(event);
        if (!firstTranscriptPoll && assistantFingerprints.get(key) !== fingerprint) pending.push(event);
        assistantFingerprints.set(key, fingerprint);
      }

      const activeAssistantKeys = new Set(assistants.keys());
      // Compare the final evidence for each identity, not every historical
      // revision against the previous poll's final value (A -> B -> A -> B).
      // Moving replacements to the end retains final-occurrence order.
      const latestModels = new Map<string | undefined, SemanticObservationEvent>();

      for (const record of records.all) {
        const model = projectClaudeTranscriptModel(record);
        if (model) {
          latestModels.delete(model.agentId);
          latestModels.set(model.agentId, model);
        }
        const pause = yieldIfNeeded();
        if (pause) await pause;
        if (disposed) return;
      }
      for (const [key, value] of latestModels) {
        const fingerprint = JSON.stringify([value.event, value.agentId ?? null, value.agentType ?? null]);
        if (modelFingerprints.get(key) === fingerprint) continue;
        modelFingerprints.set(key, fingerprint);
        pending.push(firstTranscriptPoll ? { ...value, replay: true } : value);
      }
      retainMapKeys(assistantFingerprints, activeAssistantKeys);
      retainMapKeys(modelFingerprints, new Set(latestModels.keys()));
      for (const event of pending) {
        if (disposed) return;
        emitEvent(event);
        const pause = yieldIfNeeded();
        if (pause) await pause;
      }
      lastTranscript = records;
      firstTranscriptPoll = false;
    };

    const project = async (): Promise<void> => {
      if (disposed) return;
      try {
        await projectTranscript();
      } catch (error) {
        notify(errorListeners, error instanceof Error ? error : new Error(String(error)));
      }
    };

    const poll = (_hint?: SemanticObservationPollHint): Promise<void> => {
      if (disposed) return Promise.resolve();
      if (!activePoll) {
        activePoll = Promise.resolve()
          .then(project)
          .finally(() => {
            activePoll = undefined;
          });
        return activePoll;
      }
      // A hint received during a read may describe a newer append. Keep one
      // follow-up read and let every such caller await it, without a backlog.
      if (!pendingPoll) {
        const followUp = (): Promise<void> => {
          pendingPoll = undefined;
          return poll();
        };
        pendingPoll = activePoll.then(followUp, followUp);
      }
      return pendingPoll;
    };

    const pollIntervalMs = request.pollIntervalMs ?? DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS;
    if (pollIntervalMs > 0) {
      timer = setInterval(() => void poll().catch(() => undefined), pollIntervalMs);
      timer.unref?.();
    }

    return Promise.resolve({
      onEvent(listener) {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
      onBatch(listener) {
        batchListeners.add(listener);
        return () => batchListeners.delete(listener);
      },
      onError(listener) {
        errorListeners.add(listener);
        return () => errorListeners.delete(listener);
      },
      poll,
      readArtifact: (artifactId) => Promise.resolve(unavailableArtifact(artifactId)),
      async dispose() {
        if (disposed) return;
        disposed = true;
        if (timer) clearInterval(timer);
        eventListeners.clear();
        batchListeners.clear();
        errorListeners.clear();
        await (pendingPoll ?? activePoll)?.catch(() => undefined);
      },
    });
  }
}
