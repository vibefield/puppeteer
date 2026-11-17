/** Grok durable-log tailing service. */

import { open, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GrokUpdateNormalizer } from '../normalization/pipeline.js';
import {
  GROK_REPLAY_SETTLED,
  grokRecordTimestamp,
  type GrokObservedEvent,
  type GrokSessionObserver,
  type GrokUpdateRecord,
} from '../normalization/types.js';
import { findGrokSessionDirectory, measureGrokReplayBoundary } from './session-discovery.js';

interface GrokSignals {
  contextTokensUsed?: number;
  contextWindowTokens?: number;
  contextWindowUsage?: number;
  primaryModelId?: string;
  compactionCount?: number;
  [key: string]: unknown;
}

interface GrokSummary {
  info?: { cwd?: unknown };
  cwd?: unknown;
  current_model_id?: unknown;
  currentModelId?: unknown;
  [key: string]: unknown;
}

export interface GrokSessionObserverOptions {
  /** The fast cadence, while a file changed or the rail woke the observer within `idleAfterMs`. */
  pollIntervalMs?: number;
  /** How long a change or a wake holds the fast cadence. */
  idleAfterMs?: number;
  /** The idle cadence. It is never faster than `pollIntervalMs`. */
  idlePollIntervalMs?: number;
  signalsPath?: string;
  summaryPath?: string;
  modelsCachePath?: string;
  /** Maximum allocation used for each append-only log read. */
  readChunkBytes?: number;
  /** Refuse one unterminated JSONL record after this many bytes. */
  maxRecordBytes?: number;
  /** Yield after this many newly appended bytes; the next poll continues. */
  maxBytesPerPoll?: number;
  /**
   * The log's size when the session was opened: records below it are history, every later record is live. The caller
   * that opened the session knows it (0 for a session nothing has written to yet; else `measureGrokReplayBoundary`,
   * before a prompt can reach Grok). Without it the observer measures the log as it stands at construction, the same
   * way, and never at a poll.
   */
  replayBoundary?: number;
}

/** A file as one stat sees it: a rewrite changes the key. */
function fileKey({ mtimeMs, size, ino }: { mtimeMs: number; size: number; ino: number }): string {
  return `${mtimeMs}:${size}:${ino}`;
}

export function createGrokSessionObserver(
  updatesPath: string,
  options: GrokSessionObserverOptions = {},
): GrokSessionObserver {
  const normalizer = new GrokUpdateNormalizer();
  const eventListeners = new Set<(event: GrokObservedEvent) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  let offset = 0;
  let lastSignalsMeasurement: string | undefined;
  let contextCapacity: number | undefined;
  let lastContextMeasurement: string | undefined;
  let lastContextTimestamp = 0;
  let lastCompactionCount: number | undefined;
  let lastEnvironment: string | undefined;
  let lastModelId: string | undefined;
  /** Each JSON file's key at its last successful parse, so a partial in-place rewrite is read again. */
  let parsedSignalsKey: string | undefined;
  let parsedSummaryKey: string | undefined;
  let currentUpdatesPath = updatesPath;
  let currentSessionDirectory = dirname(updatesPath);
  const sessionsRoot = dirname(dirname(currentSessionDirectory));
  let lastRelocationSearch = 0;
  let relocationSearch: Promise<void> | undefined;
  let stopped = false;
  let polling: Promise<void> | undefined;
  const pollIntervalMs = options.pollIntervalMs ?? 75;
  const idleAfterMs = options.idleAfterMs ?? 1_000;
  const idlePollIntervalMs = Math.max(pollIntervalMs, options.idlePollIntervalMs ?? 1_000);
  /** When a file last changed or the rail last woke the observer. */
  let lastActivityAt = Date.now();
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimerDueAt = 0;
  let bootstrap = true;
  /**
   * The log's size when the session was opened: a record whose first byte lies before it is replay, and any other is
   * live. It is drawn before the binding can carry a prompt, never at a poll: the first poll starts unawaited at
   * adoption and races the prompt a host submits at once, and a line drawn after that prompt's first records would
   * replay them and settle a live turn.
   */
  const bootstrapTargetOffset = options.replayBoundary ?? measureGrokReplayBoundary(updatesPath);
  const readChunkBytes = Math.max(1, Math.floor(options.readChunkBytes ?? 64 * 1024));
  const maxRecordBytes = Math.max(readChunkBytes, Math.floor(options.maxRecordBytes ?? 1024 * 1024));
  const maxBytesPerPoll = Math.max(readChunkBytes, Math.floor(options.maxBytesPerPoll ?? 4 * 1024 * 1024));
  let pendingUpdate = Buffer.alloc(0);
  /** The file offset of the first byte of the record being read. */
  let updateStartOffset = 0;
  let discardingOversizedUpdate = false;

  const report = (error: unknown): void => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const listener of errorListeners) {
      try {
        listener(normalized);
      } catch {
        // Consumer faults stay out of the tail.
      }
    }
  };

  const emit = (event: GrokObservedEvent): void => {
    for (const listener of eventListeners) {
      try {
        listener(event);
      } catch {
        // One consumer cannot break observation for the others.
      }
    }
  };

  const reportOversizedUpdate = (): void => {
    report(new Error(`Grok update record exceeds the ${maxRecordBytes}-byte safety limit`));
  };

  /**
   * A replay is a baseline: a launch or resume process is not in the middle of what the log last shows. What it left
   * open ends here, ahead of any live record, and a marker says so. A log with nothing to replay has neither.
   */
  const endReplay = (): void => {
    if (!bootstrap) return;
    if (bootstrapTargetOffset) {
      for (const event of normalizer.settleReplay()) emit({ ...event, phase: 'bootstrap' });
      emit({
        event: { type: 'adapter:native-event', adapter: 'grok', nativeType: GROK_REPLAY_SETTLED },
        phase: 'bootstrap',
        source: 'runtime',
        confidence: 'derived',
        nativeEvent: { code: 'grok-replay-settled' },
      });
    }
    bootstrap = false;
  };

  const normalizeUpdateLine = (line: Buffer, startOffset: number): void => {
    if (line.length === 0) return;
    if (startOffset >= bootstrapTargetOffset) endReplay();
    try {
      const record = JSON.parse(line.toString('utf8')) as GrokUpdateRecord;
      for (const event of normalizer.normalize(record, { replay: bootstrap })) {
        emit({ ...event, phase: bootstrap ? 'bootstrap' : 'live' });
      }
      // Grok writes signals.json at turn boundaries. During a long tool loop,
      // update metadata carries the same context occupancy shown by its TUI.
      const usedTokens = record.params?._meta?.totalTokens;
      const timestamp = grokRecordTimestamp(record);
      const at = timestamp ? Date.parse(timestamp) : undefined;
      if (
        (record.method === 'session/update' || record.method === '_x.ai/session/update') &&
        typeof record.params?.update?.sessionUpdate === 'string' &&
        typeof usedTokens === 'number' &&
        Number.isFinite(usedTokens) &&
        usedTokens >= 0 &&
        contextCapacity !== undefined &&
        at !== undefined &&
        at >= lastContextTimestamp
      ) {
        lastContextTimestamp = at;
        const measurement = `${usedTokens}:${contextCapacity}`;
        if (measurement === lastContextMeasurement) return;
        lastContextMeasurement = measurement;
        emit({
          event: { type: 'context-window:updated', usedTokens, capacityTokens: contextCapacity },
          timestamp,
          phase: bootstrap ? 'bootstrap' : 'live',
          source: 'native-log',
          confidence: 'authoritative',
          nativeEvent: record,
        });
      }
    } catch (error) {
      report(new Error(`invalid Grok update record: ${error instanceof Error ? error.message : String(error)}`));
    }
  };

  /** Consume arbitrary file chunks, read from `chunkOffset`, while retaining at most one bounded partial line. */
  const consumeUpdateBytes = (chunk: Buffer, chunkOffset: number): void => {
    let cursor = 0;
    while (cursor < chunk.length) {
      if (discardingOversizedUpdate) {
        const newline = chunk.indexOf(0x0a, cursor);
        if (newline < 0) return;
        discardingOversizedUpdate = false;
        cursor = newline + 1;
        updateStartOffset = chunkOffset + cursor;
        continue;
      }

      const newline = chunk.indexOf(0x0a, cursor);
      const end = newline < 0 ? chunk.length : newline;
      const fragment = chunk.subarray(cursor, end);
      if (pendingUpdate.length + fragment.length > maxRecordBytes) {
        reportOversizedUpdate();
        pendingUpdate = Buffer.alloc(0);
        if (newline < 0) discardingOversizedUpdate = true;
      } else if (newline < 0) {
        pendingUpdate = pendingUpdate.length === 0 ? Buffer.from(fragment) : Buffer.concat([pendingUpdate, fragment]);
      } else {
        const complete = pendingUpdate.length === 0 ? fragment : Buffer.concat([pendingUpdate, fragment]);
        pendingUpdate = Buffer.alloc(0);
        normalizeUpdateLine(complete, updateStartOffset);
      }
      if (newline < 0) return;
      cursor = newline + 1;
      updateStartOffset = chunkOffset + cursor;
    }
  };

  /** A file is missing: the session's directory may be in another cwd bucket. One search at a time, one a second. */
  const locateRelocatedSession = async (): Promise<void> => {
    if (relocationSearch) return relocationSearch;
    const now = Date.now();
    if (now - lastRelocationSearch < 1_000) return;
    lastRelocationSearch = now;
    const pending = (async (): Promise<void> => {
      const directory = await findGrokSessionDirectory(updatesPath);
      if (directory === undefined) return;
      currentSessionDirectory = directory;
      currentUpdatesPath = join(directory, 'updates.jsonl');
    })();
    relocationSearch = pending;
    try {
      await pending;
    } finally {
      if (relocationSearch === pending) relocationSearch = undefined;
    }
  };

  const pollUpdates = async (): Promise<void> => {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const info = await stat(currentUpdatesPath);
      if (info.size < offset) {
        offset = 0;
        updateStartOffset = 0;
        pendingUpdate = Buffer.alloc(0);
        discardingOversizedUpdate = false;
      }
      if (info.size !== offset) {
        lastActivityAt = Date.now();
        handle = await open(currentUpdatesPath, 'r');
        let remaining = Math.min(info.size - offset, maxBytesPerPoll);
        while (remaining > 0) {
          const requested = Math.min(readChunkBytes, remaining);
          const chunk = Buffer.allocUnsafe(requested);
          const { bytesRead } = await handle.read(chunk, 0, requested, offset);
          if (bytesRead === 0) break;
          const chunkOffset = offset;
          offset += bytesRead;
          remaining -= bytesRead;
          consumeUpdateBytes(chunk.subarray(0, bytesRead), chunkOffset);
        }
      }
      // Every replayed record is out once the next record, whole or not, starts at or past the boundary.
      if (updateStartOffset >= bootstrapTargetOffset) endReplay();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Find the log, never measure it: the next poll reads it where it is, against the boundary drawn at open. A
        // session with no log when it was opened has nothing to replay, so its replay ends here.
        await locateRelocatedSession();
        if (bootstrapTargetOffset === 0) endReplay();
      } else report(error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };

  const pollSignals = async (): Promise<void> => {
    const signalsPath = options.signalsPath ?? join(currentSessionDirectory, 'signals.json');
    try {
      const info = await stat(signalsPath);
      const key = fileKey(info);
      if (key === parsedSignalsKey) return;
      const raw = await readFile(signalsPath, 'utf8');
      let signals: GrokSignals;
      try {
        signals = JSON.parse(raw) as GrokSignals;
      } catch {
        // Grok replaces this file in place. A partial rewrite is transient and
        // must be retried on the next poll rather than surfaced as corruption.
        return;
      }
      parsedSignalsKey = key;
      lastActivityAt = Date.now();

      const compactionCount = signals.compactionCount;
      const compacted =
        typeof compactionCount === 'number' &&
        typeof lastCompactionCount === 'number' &&
        compactionCount > lastCompactionCount;
      if (typeof compactionCount === 'number') lastCompactionCount = compactionCount;

      const usedTokens = signals.contextTokensUsed;
      const capacityTokens = signals.contextWindowTokens;
      if (
        contextCapacity === undefined &&
        typeof capacityTokens === 'number' &&
        Number.isFinite(capacityTokens) &&
        capacityTokens > 0
      ) {
        contextCapacity = capacityTokens;
      }
      if (
        typeof usedTokens !== 'number' ||
        !Number.isFinite(usedTokens) ||
        usedTokens < 0 ||
        typeof capacityTokens !== 'number' ||
        !Number.isFinite(capacityTokens) ||
        capacityTokens <= 0
      ) {
        if (compacted) {
          lastSignalsMeasurement = undefined;
          lastContextMeasurement = undefined;
          emit({
            event: { type: 'context-window:invalidated', reason: 'compacted' },
            phase: bootstrap ? 'bootstrap' : 'live',
            source: 'native-log',
            confidence: 'authoritative',
            nativeEvent: signals,
          });
        }
        return;
      }

      const modelId = typeof signals.primaryModelId === 'string' ? signals.primaryModelId : undefined;
      const fingerprint = `${usedTokens}:${capacityTokens}:${modelId ?? ''}`;
      if (fingerprint === lastSignalsMeasurement) return;
      lastSignalsMeasurement = fingerprint;
      if (info.mtimeMs < lastContextTimestamp) return;
      contextCapacity = capacityTokens;
      lastContextTimestamp = info.mtimeMs;
      lastContextMeasurement = `${usedTokens}:${capacityTokens}`;
      emit({
        event: { type: 'context-window:updated', usedTokens, capacityTokens, modelId },
        phase: bootstrap ? 'bootstrap' : 'live',
        source: 'native-log',
        confidence: 'authoritative',
        nativeEvent: signals,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report(error);
    }
  };

  const pollSummary = async (): Promise<void> => {
    const summaryPath = options.summaryPath ?? join(currentSessionDirectory, 'summary.json');
    try {
      const key = fileKey(await stat(summaryPath));
      if (key === parsedSummaryKey) return;
      const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as GrokSummary;
      parsedSummaryKey = key;
      lastActivityAt = Date.now();
      const currentCwd =
        typeof summary.info?.cwd === 'string'
          ? summary.info.cwd
          : typeof summary.cwd === 'string'
            ? summary.cwd
            : undefined;
      const modelId =
        typeof summary.current_model_id === 'string'
          ? summary.current_model_id
          : typeof summary.currentModelId === 'string'
            ? summary.currentModelId
            : undefined;
      if (!currentCwd && !modelId) return;
      const fingerprint = `${currentCwd ?? ''}:${modelId ?? ''}`;
      if (fingerprint === lastEnvironment) return;
      lastEnvironment = fingerprint;
      const observation = {
        phase: bootstrap ? ('bootstrap' as const) : ('live' as const),
        source: 'native-log' as const,
        confidence: 'authoritative' as const,
        nativeEvent: summary,
      };
      if (currentCwd) emit({ ...observation, event: { type: 'environment:updated', currentCwd } });
      if (modelId) {
        if (modelId !== lastModelId) {
          const needsCapacity = contextCapacity === undefined || lastModelId !== undefined;
          lastModelId = modelId;
          // Fresh sessions do not have signals.json until their first turn
          // finishes. Grok's own model cache supplies capacity in the meantime.
          try {
            const cache = JSON.parse(
              await readFile(options.modelsCachePath ?? join(dirname(sessionsRoot), 'models_cache.json'), 'utf8'),
            );
            const capacity = cache?.models?.[modelId]?.context_window;
            if (needsCapacity && typeof capacity === 'number' && Number.isFinite(capacity) && capacity > 0)
              contextCapacity = capacity;
          } catch {
            // Signals/ACP remain authoritative when there is no cached model.
          }
        }
        emit({ ...observation, event: { type: 'model:updated', model: { id: modelId, provider: 'xai' } } });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') await locateRelocatedSession();
      else if (error instanceof SyntaxError) return;
      else report(error);
    }
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    if (polling) return polling;
    // Load capacity before replaying metadata so even the first prompt can
    // publish a live context measurement. Historical metadata cannot replace
    // a newer signals snapshot because both carry their measurement time.
    polling = pollSignals()
      .then(pollSummary)
      .then(pollUpdates)
      .finally(() => {
        polling = undefined;
      });
    return polling;
  };

  /** One timer at a time: the next delay is chosen when a poll ends, so polls never overlap. */
  const schedulePoll = (delayMs: number): void => {
    clearTimeout(pollTimer);
    pollTimerDueAt = Date.now() + delayMs;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      void poll().finally(() => {
        if (stopped) return;
        schedulePoll(Date.now() - lastActivityAt < idleAfterMs ? pollIntervalMs : idlePollIntervalMs);
      });
    }, delayMs);
    pollTimer.unref?.();
  };
  schedulePoll(pollIntervalMs);

  return {
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    poll,
    wake() {
      if (stopped) return;
      lastActivityAt = Date.now();
      // Pull a slow timer forward. A nearer one, or a poll in flight, already keeps the fast cadence.
      if (pollTimer !== undefined && pollTimerDueAt - lastActivityAt > pollIntervalMs) schedulePoll(pollIntervalMs);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(pollTimer);
      eventListeners.clear();
      errorListeners.clear();
    },
  };
}
