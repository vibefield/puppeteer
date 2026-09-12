import type { MonitorArtifactReadResult } from '@vibecook/puppeteer-core';
import type { AdapterMonitorObservationBatch, ObservationCapability } from '@vibecook/puppeteer-core/monitor-spi';
import type {
  SemanticObservationAttachRequest,
  SemanticObservationEvent,
  SemanticObservationHandle,
  SemanticObservationPollHint,
  SemanticObservationProvider,
} from '../semantic-provider.js';
import { createClaudeWorkflowJournalObserver } from '../workflow/journal.js';
import { claudeTranscriptConversationFingerprint, projectClaudeTranscriptConversation } from './conversation.js';
import { projectClaudeTranscriptModel } from './model.js';
import {
  createClaudeSessionTranscriptReader,
  type ClaudeSessionTranscriptSnapshot,
} from './services/session-reader.js';
import { createTranscriptYield } from './services/yield.js';
import { safeTranscriptEvidence, transcriptRecordId } from './wire.js';

const TRANSCRIPT_CAPABILITIES: readonly ObservationCapability[] = [
  {
    family: 'workflow',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'sample',
    source: 'claude-workflow-journals',
    limitations: ['Membership is exact for journaled workers; abandoned starts settle after an idle timeout.'],
  },
] as const;

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
    return Promise.resolve(TRANSCRIPT_CAPABILITIES);
  }

  attach(request: SemanticObservationAttachRequest): Promise<SemanticObservationHandle> {
    const eventListeners = new Set<(event: SemanticObservationEvent) => void>();
    const batchListeners = new Set<(batch: AdapterMonitorObservationBatch) => void>();
    const errorListeners = new Set<(error: Error) => void>();
    const assistantFingerprints = new Map<string, string>();
    const evidenceFingerprints = new Map<string, string>();
    const workflowFingerprints = new Map<string, string>();
    let lastTranscript: ClaudeSessionTranscriptSnapshot | undefined;
    let firstTranscriptPoll = true;
    let firstWorkflowPoll = true;
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let activePoll: Promise<void> | undefined;
    let pendingPoll: Promise<void> | undefined;
    const transcriptReader = createClaudeSessionTranscriptReader(request.transcriptPath, request.nativeSessionId);
    const workflowObserver = createClaudeWorkflowJournalObserver(request.transcriptPath, request.nativeSessionId);

    const emitEvent = (value: SemanticObservationEvent): void => notify(eventListeners, value);

    const projectTranscript = async (): Promise<void> => {
      const records = await transcriptReader.read();
      if (disposed || records === lastTranscript) return;
      const yieldIfNeeded = createTranscriptYield();
      const pending: SemanticObservationEvent[] = [];
      const conversation = projectClaudeTranscriptConversation(records.root);

      if (firstTranscriptPoll && request.bootstrap) {
        pending.push(...conversation.history);
      } else {
        for (const [key, event] of conversation.assistants) {
          const fingerprint = claudeTranscriptConversationFingerprint(event);
          if (assistantFingerprints.get(key) === fingerprint) continue;
          assistantFingerprints.set(key, fingerprint);
          pending.push(event);
        }
      }
      for (const [key, event] of conversation.assistants) {
        assistantFingerprints.set(key, claudeTranscriptConversationFingerprint(event));
      }

      const activeAssistantKeys = new Set(conversation.assistants.keys());
      // Compare the final evidence for each identity, not every historical
      // revision against the previous poll's final value (A -> B -> A -> B).
      // Moving replacements to the end retains final-occurrence order.
      const latest = new Map<string, SemanticObservationEvent>();
      const select = (key: string, value: SemanticObservationEvent): void => {
        latest.delete(key);
        latest.set(key, value);
      };

      for (const record of records.all) {
        const model = projectClaudeTranscriptModel(record);
        if (model) select(`model:${JSON.stringify(model.agentId ?? null)}`, model);

        const role = record.message?.role;
        const knownConversation =
          record.type === 'user' || record.type === 'assistant' || role === 'user' || role === 'assistant';
        if (!knownConversation && !model) {
          const key = `native:${record.sourceId}:${transcriptRecordId(record)}:${record.type ?? 'record'}`;
          select(key, {
            event: {
              type: 'adapter:native-event',
              adapter: 'claude-code',
              nativeType: `transcript:${record.type ?? 'record'}`,
            },
            timestamp: record.timestamp,
            nativeEvent: safeTranscriptEvidence(record),
          });
        }
        const pause = yieldIfNeeded();
        if (pause) await pause;
        if (disposed) return;
      }
      for (const [key, value] of latest) {
        const fingerprint = JSON.stringify([value.event, value.agentId ?? null, value.agentType ?? null]);
        if (evidenceFingerprints.get(key) === fingerprint) continue;
        evidenceFingerprints.set(key, fingerprint);
        pending.push(firstTranscriptPoll && request.bootstrap ? { ...value, replay: true } : value);
      }
      retainMapKeys(assistantFingerprints, activeAssistantKeys);
      retainMapKeys(evidenceFingerprints, new Set(latest.keys()));
      for (const event of pending) {
        if (disposed) return;
        emitEvent(event);
        const pause = yieldIfNeeded();
        if (pause) await pause;
      }
      lastTranscript = records;
      firstTranscriptPoll = false;
    };

    const projectWorkflows = async (): Promise<void> => {
      const workflows = await workflowObserver.read();
      if (disposed) return;
      const yieldIfNeeded = createTranscriptYield();
      const activeWorkflowIds = new Set(workflows.map(({ event }) => event.workflowId));
      for (const workflow of workflows) {
        const fingerprint = JSON.stringify(workflow.event);
        if (workflowFingerprints.get(workflow.event.workflowId) === fingerprint) continue;
        workflowFingerprints.set(workflow.event.workflowId, fingerprint);
        emitEvent({
          event: workflow.event,
          timestamp: workflow.timestamp,
          ...(firstWorkflowPoll && request.bootstrap ? { replay: true } : {}),
          nativeEvent: workflow.nativeEvent,
        });
        const pause = yieldIfNeeded();
        if (pause) await pause;
        if (disposed) return;
      }
      retainMapKeys(workflowFingerprints, activeWorkflowIds);
      firstWorkflowPoll = false;
    };

    const project = async (): Promise<void> => {
      if (disposed) return;
      try {
        await projectTranscript();
      } catch (error) {
        notify(errorListeners, error instanceof Error ? error : new Error(String(error)));
      }
      try {
        await projectWorkflows();
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
