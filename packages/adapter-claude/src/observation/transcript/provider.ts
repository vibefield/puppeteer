import { partitionAttachBootstrap } from '@vibefield/puppeteer-core';
import type { AdapterMonitorObservationBatch, ObservationCapability } from '@vibefield/puppeteer-core/monitor-spi';
import type {
  SemanticObservationAttachRequest,
  SemanticObservationEvent,
  SemanticObservationHandle,
  SemanticObservationPollHint,
  SemanticObservationProvider,
} from '../semantic-provider.js';
import {
  ClaudeTranscriptProjection,
  projectClaudeTranscriptOpenWork,
  type ClaudeTranscriptDelta,
} from './conversation.js';
import { createClaudeTranscriptReader } from './services/jsonl-reader.js';
import { createTranscriptYield } from './services/yield.js';
import type { ClaudeTranscriptRecord } from './wire.js';

const DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS = 1_000;

/**
 * What changed between two snapshots of one reader, which appends at its tail, evicts at its head and keeps the same
 * record objects in line order (jsonl-reader.ts): the previous last row's place in the new snapshot splits the rows
 * evicted from the rows appended. Anything else has no delta, and the projection walks the window whole: the first
 * read, a truncation or rotation that reset the reader (its records are new objects), or the previous last row itself
 * evicted.
 */
function transcriptDelta(
  previous: readonly ClaudeTranscriptRecord[] | undefined,
  next: readonly ClaudeTranscriptRecord[],
): ClaudeTranscriptDelta | undefined {
  const last = previous?.at(-1);
  if (previous === undefined || last === undefined) return undefined;
  let low = 0;
  let high = next.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const candidate = next[middle]!;
    if (candidate.index < last.index) low = middle + 1;
    else if (candidate.index > last.index) high = middle - 1;
    else if (candidate !== last) return undefined;
    else return { evicted: previous.slice(0, previous.length - (middle + 1)), appended: next.slice(middle + 1) };
  }
  return undefined;
}

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
    const projection = new ClaudeTranscriptProjection(request.nativeSessionId);
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
      const changed = projection.apply(records, transcriptDelta(lastTranscript, records));
      lastTranscript = records;
      // Existing messages form a silent baseline on every attachment,
      // including picker rebinds. Only later changes are live observations.
      const pending: SemanticObservationEvent[] = firstTranscriptPoll ? [] : changed;
      // An attached session's first read: what the transcript shows still open is where the agent stands now. It
      // happened before this observer, so it is replay, except a question the agent waits on, which is announced
      // live once after it, so the person is told (re-attach study, §3.3).
      if (firstTranscriptPoll && request.attached === true) {
        const open = projectClaudeTranscriptOpenWork(projection.sessionRows(records));
        const found = new Map(open.map((value) => [value.event, value]));
        const { replay, announce } = partitionAttachBootstrap(open.map(({ event }) => event));
        for (const event of replay) pending.push({ ...found.get(event)!, replay: true, openAtAttach: true });
        for (const event of announce) pending.push({ ...found.get(event)!, openAtAttach: true });
      }
      firstTranscriptPoll = false;
      const yieldIfNeeded = createTranscriptYield();
      for (const event of pending) {
        if (disposed) return;
        emitEvent(event);
        const pause = yieldIfNeeded();
        if (pause) await pause;
      }
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
