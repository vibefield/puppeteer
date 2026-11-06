import { partitionAttachBootstrap } from '@vibefield/puppeteer-core';
import type { AdapterMonitorObservationBatch, ObservationCapability } from '@vibefield/puppeteer-core/monitor-spi';
import type {
  SemanticObservationAttachRequest,
  SemanticObservationEvent,
  SemanticObservationHandle,
  SemanticObservationPollHint,
  SemanticObservationProvider,
} from '../semantic-provider.js';
import { projectClaudeTranscriptAssistants, projectClaudeTranscriptOpenWork } from './conversation.js';
import { createClaudeTranscriptReader } from './services/jsonl-reader.js';
import { createTranscriptYield } from './services/yield.js';
import type { ClaudeTranscriptRecord } from './wire.js';

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

export class ClaudeTranscriptObservationProvider implements SemanticObservationProvider {
  capabilities(): Promise<readonly ObservationCapability[]> {
    return Promise.resolve([]);
  }

  attach(request: SemanticObservationAttachRequest): Promise<SemanticObservationHandle> {
    const eventListeners = new Set<(event: SemanticObservationEvent) => void>();
    const batchListeners = new Set<(batch: AdapterMonitorObservationBatch) => void>();
    const errorListeners = new Set<(error: Error) => void>();
    // What each message last said: its turn and its text, the only fields that vary (messageId is the key; final and
    // displayOnly never vary). A message is published again only when one of them changes.
    const published = new Map<string, { turnId: string | undefined; text: string }>();
    // The parents that have left the window: uuids an earlier read held and a later one lost while a row it still holds
    // names them. Those rows' ancestry was cut by the window, never by the transcript (conversation.ts,
    // stepAssistantWalk); a parent that has not arrived yet is never here. Bounded by the window, as `held` is.
    const departed = new Set<string>();
    let held = new Set<string>();
    let lastTranscript: readonly ClaudeTranscriptRecord[] | undefined;
    let firstTranscriptPoll = true;
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let activePoll: Promise<void> | undefined;
    let pendingPoll: Promise<void> | undefined;
    const transcriptReader = createClaudeTranscriptReader(request.transcriptPath);

    const emitEvent = (value: SemanticObservationEvent): void => notify(eventListeners, value);

    const projectTranscript = async (): Promise<void> => {
      const records = await transcriptReader.read();
      if (disposed || records === lastTranscript) return;
      const yieldIfNeeded = createTranscriptYield();
      const pending: SemanticObservationEvent[] = [];
      const session = records.filter((record) => !record.sessionId || record.sessionId === request.nativeSessionId);
      const uuids = new Set<string>();
      for (const record of session) if (record.uuid !== undefined) uuids.add(record.uuid);
      const missing = new Set<string>();
      for (const record of session) {
        if (record.parentUuid !== undefined && !uuids.has(record.parentUuid)) missing.add(record.parentUuid);
      }
      for (const uuid of held) if (!uuids.has(uuid) && missing.has(uuid)) departed.add(uuid);
      for (const uuid of departed) if (!missing.has(uuid)) departed.delete(uuid);
      held = uuids;
      const assistants = projectClaudeTranscriptAssistants(session, {
        knownTurns: new Map([...published].map(([key, { turnId }]): [string, string | undefined] => [key, turnId])),
        departed,
      });

      // Existing messages form a silent baseline on every attachment,
      // including picker rebinds. Only later changes are live observations.
      for (const [key, value] of assistants) {
        const text = value.event.type === 'conversation:assistant-message' ? value.event.text : '';
        const previous = published.get(key);
        const changed = previous === undefined || previous.turnId !== value.turnId || previous.text !== text;
        if (!firstTranscriptPoll && changed) pending.push(value);
        published.set(key, { turnId: value.turnId, text });
        const pause = yieldIfNeeded();
        if (pause) await pause;
        if (disposed) return;
      }
      for (const key of published.keys()) {
        if (!assistants.has(key)) published.delete(key);
      }
      // An attached session's first read: what the transcript shows still open is where the agent stands now. It
      // happened before this observer, so it is replay, except a question the agent waits on, which is announced
      // live once after it, so the person is told (re-attach study, §3.3).
      if (firstTranscriptPoll && request.attached === true) {
        const open = projectClaudeTranscriptOpenWork(session);
        const found = new Map(open.map((value) => [value.event, value]));
        const { replay, announce } = partitionAttachBootstrap(open.map(({ event }) => event));
        for (const event of replay) pending.push({ ...found.get(event)!, replay: true, openAtAttach: true });
        for (const event of announce) pending.push({ ...found.get(event)!, openAtAttach: true });
      }
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
