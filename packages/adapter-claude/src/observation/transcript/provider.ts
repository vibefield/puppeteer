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
import { createClaudeSessionTranscriptReader } from './services/session-reader.js';
import { projectClaudeTranscriptUsage } from './usage.js';
import { safeTranscriptEvidence, transcriptRecordId } from './wire.js';

const TRANSCRIPT_CAPABILITIES: readonly ObservationCapability[] = [
  {
    family: 'usage',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'historical',
    source: 'claude-transcript-jsonl',
    limitations: ['Durable response usage is a fallback when the authenticated OTLP log exporter is unavailable.'],
  },
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

function retainSetKeys<Key>(set: Set<Key>, active: ReadonlySet<Key>): void {
  for (const key of set) {
    if (!active.has(key)) set.delete(key);
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
    const usageFingerprints = new Map<string, string>();
    const modelFingerprints = new Map<string, string>();
    const workflowFingerprints = new Map<string, string>();
    const unknownFingerprints = new Set<string>();
    let firstTranscriptPoll = true;
    let firstWorkflowPoll = true;
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let pollQueue = Promise.resolve();
    const transcriptReader = createClaudeSessionTranscriptReader(request.transcriptPath, request.nativeSessionId);
    const workflowObserver = createClaudeWorkflowJournalObserver(request.transcriptPath, request.nativeSessionId);

    const emitEvent = (value: SemanticObservationEvent): void => notify(eventListeners, value);

    const projectTranscript = async (): Promise<void> => {
      const records = await transcriptReader.read();
      const conversation = projectClaudeTranscriptConversation(records.root);

      if (firstTranscriptPoll && request.bootstrap) {
        for (const event of conversation.history) emitEvent(event);
      } else {
        for (const [key, event] of conversation.assistants) {
          const fingerprint = claudeTranscriptConversationFingerprint(event);
          if (assistantFingerprints.get(key) === fingerprint) continue;
          assistantFingerprints.set(key, fingerprint);
          emitEvent(event);
        }
      }
      for (const [key, event] of conversation.assistants) {
        assistantFingerprints.set(key, claudeTranscriptConversationFingerprint(event));
      }

      const activeAssistantKeys = new Set(conversation.assistants.keys());
      const activeUsageKeys = new Set<string>();
      const activeModelKeys = new Set<string>();
      const activeUnknownKeys = new Set<string>();

      for (const record of records.all) {
        const usage = projectClaudeTranscriptUsage(record);
        if (usage?.event.type === 'usage:tokens-used') {
          activeUsageKeys.add(usage.event.usageId);
          const fingerprint = JSON.stringify([usage.event, usage.agentId ?? null, usage.agentType ?? null]);
          if (usageFingerprints.get(usage.event.usageId) !== fingerprint) {
            usageFingerprints.set(usage.event.usageId, fingerprint);
            emitEvent(firstTranscriptPoll && request.bootstrap ? { ...usage, replay: true } : usage);
          }
        }

        const model = projectClaudeTranscriptModel(record);
        if (model) {
          const key = model.agentId ?? 'root';
          activeModelKeys.add(key);
          const fingerprint = JSON.stringify(model.event);
          if (modelFingerprints.get(key) !== fingerprint) {
            modelFingerprints.set(key, fingerprint);
            emitEvent(firstTranscriptPoll && request.bootstrap ? { ...model, replay: true } : model);
          }
        }

        const role = record.message?.role;
        const knownConversation =
          record.type === 'user' || record.type === 'assistant' || role === 'user' || role === 'assistant';
        if (!knownConversation && !usage && !model) {
          const key = `${record.sourceId}:${transcriptRecordId(record)}:${record.type ?? 'record'}`;
          activeUnknownKeys.add(key);
          if (!unknownFingerprints.has(key)) {
            unknownFingerprints.add(key);
            emitEvent({
              event: {
                type: 'adapter:native-event',
                adapter: 'claude-code',
                nativeType: `transcript:${record.type ?? 'record'}`,
              },
              timestamp: record.timestamp,
              ...(firstTranscriptPoll && request.bootstrap ? { replay: true } : {}),
              nativeEvent: safeTranscriptEvidence(record),
            });
          }
        }
      }
      retainMapKeys(assistantFingerprints, activeAssistantKeys);
      retainMapKeys(usageFingerprints, activeUsageKeys);
      retainMapKeys(modelFingerprints, activeModelKeys);
      retainSetKeys(unknownFingerprints, activeUnknownKeys);
      firstTranscriptPoll = false;
    };

    const projectWorkflows = async (): Promise<void> => {
      const workflows = await workflowObserver.read();
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
      const run = async (): Promise<void> => {
        await project();
      };
      pollQueue = pollQueue.then(run, run);
      return pollQueue;
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
        await pollQueue.catch(() => undefined);
      },
    });
  }
}
