import type { MonitorArtifactReadResult } from '@vibecook/puppeteer-core';
import type { AdapterMonitorObservationBatch, ObservationCapability } from '@vibecook/puppeteer-core/monitor-spi';
import type {
  SemanticObservationAttachRequest,
  SemanticObservationEvent,
  SemanticObservationHandle,
  SemanticObservationPollHint,
  SemanticObservationProvider,
} from '../semantic-provider.js';
import { observeClaudeWorkflowJournals } from '../workflow/journal.js';
import { claudeTranscriptConversationFingerprint, projectClaudeTranscriptConversation } from './conversation.js';
import { projectClaudeTranscriptEnvironment } from './environment.js';
import { createClaudeSessionTranscriptReader } from './services/session-reader.js';
import { projectClaudeTranscriptUsage } from './usage.js';

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
    const environmentFingerprints = new Map<string, string>();
    const workflowFingerprints = new Map<string, string>();
    let firstPoll = true;
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let pollQueue = Promise.resolve();
    const transcriptReader = createClaudeSessionTranscriptReader(request.transcriptPath, request.nativeSessionId);

    const emitEvent = (value: SemanticObservationEvent): void => notify(eventListeners, value);

    const project = async (): Promise<void> => {
      if (disposed) return;
      const records = await transcriptReader.read();
      const conversation = projectClaudeTranscriptConversation(records.root);

      if (firstPoll && request.bootstrap) {
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

      for (const record of records.all) {
        const usage = projectClaudeTranscriptUsage(record);
        if (usage?.event.type === 'tokens.used') {
          const fingerprint = JSON.stringify(usage.event);
          if (usageFingerprints.get(usage.event.usageId) !== fingerprint) {
            usageFingerprints.set(usage.event.usageId, fingerprint);
            emitEvent(firstPoll && request.bootstrap ? { ...usage, replay: true } : usage);
          }
        }

        const environment = projectClaudeTranscriptEnvironment(record);
        if (environment) {
          const key = environment.agentId ?? 'root';
          const fingerprint = JSON.stringify(environment.event);
          if (environmentFingerprints.get(key) !== fingerprint) {
            environmentFingerprints.set(key, fingerprint);
            emitEvent(firstPoll && request.bootstrap ? { ...environment, replay: true } : environment);
          }
        }
      }

      const workflows = await observeClaudeWorkflowJournals(request.transcriptPath, request.nativeSessionId);
      for (const workflow of workflows) {
        const fingerprint = JSON.stringify(workflow.event);
        if (workflowFingerprints.get(workflow.event.workflowId) === fingerprint) continue;
        workflowFingerprints.set(workflow.event.workflowId, fingerprint);
        emitEvent({
          event: workflow.event,
          timestamp: workflow.timestamp,
          ...(firstPoll && request.bootstrap ? { replay: true } : {}),
          nativeEvent: workflow.nativeEvent,
        });
      }
      firstPoll = false;
    };

    const poll = (_hint?: SemanticObservationPollHint): Promise<void> => {
      const run = async (): Promise<void> => {
        try {
          await project();
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          notify(errorListeners, normalized);
          throw normalized;
        }
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
