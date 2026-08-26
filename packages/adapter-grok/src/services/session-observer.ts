/** Grok durable-log tailing service. */

import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { GrokUpdateNormalizer } from '../normalization/pipeline.js';
import type { GrokObservedEvent, GrokSessionObserver } from '../normalization/types.js';

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
  pollIntervalMs?: number;
  signalsPath?: string;
  summaryPath?: string;
  /** Maximum allocation used for each append-only log read. */
  readChunkBytes?: number;
  /** Refuse one unterminated JSONL record after this many bytes. */
  maxRecordBytes?: number;
  /** Yield after this many newly appended bytes; the next poll continues. */
  maxBytesPerPoll?: number;
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
  let lastCompactionCount: number | undefined;
  let lastEnvironment: string | undefined;
  let currentUpdatesPath = updatesPath;
  let currentSessionDirectory = dirname(updatesPath);
  const sessionId = basename(currentSessionDirectory);
  const sessionsRoot = dirname(dirname(currentSessionDirectory));
  let lastRelocationSearch = 0;
  let relocationSearch: Promise<void> | undefined;
  let stopped = false;
  let polling: Promise<void> | undefined;
  let bootstrap = true;
  let bootstrapTargetOffset: number | undefined;
  let bootstrapUpdatesComplete = false;
  const readChunkBytes = Math.max(1, Math.floor(options.readChunkBytes ?? 64 * 1024));
  const maxRecordBytes = Math.max(readChunkBytes, Math.floor(options.maxRecordBytes ?? 1024 * 1024));
  const maxBytesPerPoll = Math.max(readChunkBytes, Math.floor(options.maxBytesPerPoll ?? 4 * 1024 * 1024));
  let pendingUpdate = Buffer.alloc(0);
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

  const normalizeUpdateLine = (line: Buffer): void => {
    if (line.length === 0) return;
    try {
      for (const event of normalizer.normalize(JSON.parse(line.toString('utf8')))) {
        emit({ ...event, phase: bootstrap ? 'bootstrap' : 'live' });
      }
    } catch (error) {
      report(new Error(`invalid Grok update record: ${error instanceof Error ? error.message : String(error)}`));
    }
  };

  /** Consume arbitrary file chunks while retaining at most one bounded partial line. */
  const consumeUpdateBytes = (chunk: Buffer): void => {
    let cursor = 0;
    while (cursor < chunk.length) {
      if (discardingOversizedUpdate) {
        const newline = chunk.indexOf(0x0a, cursor);
        if (newline < 0) return;
        discardingOversizedUpdate = false;
        cursor = newline + 1;
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
        normalizeUpdateLine(complete);
      }
      if (newline < 0) return;
      cursor = newline + 1;
    }
  };

  const locateRelocatedSession = async (): Promise<void> => {
    if (relocationSearch) return relocationSearch;
    const now = Date.now();
    if (now - lastRelocationSearch < 1_000) return;
    lastRelocationSearch = now;
    const pending = (async (): Promise<void> => {
      try {
        for (const cwdDirectory of await readdir(sessionsRoot)) {
          const candidate = join(sessionsRoot, cwdDirectory, sessionId);
          try {
            await stat(join(candidate, 'summary.json'));
            currentSessionDirectory = candidate;
            currentUpdatesPath = join(candidate, 'updates.jsonl');
            return;
          } catch {
            // Continue scanning cwd buckets.
          }
        }
      } catch {
        // The next regular poll retries.
      }
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
      handle = await open(currentUpdatesPath, 'r');
      const info = await handle.stat();
      bootstrapTargetOffset ??= info.size;
      if (info.size < offset) {
        offset = 0;
        pendingUpdate = Buffer.alloc(0);
        discardingOversizedUpdate = false;
      }
      let remaining = Math.min(info.size - offset, maxBytesPerPoll);
      while (remaining > 0) {
        const requested = Math.min(readChunkBytes, remaining);
        const chunk = Buffer.allocUnsafe(requested);
        const { bytesRead } = await handle.read(chunk, 0, requested, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
        remaining -= bytesRead;
        consumeUpdateBytes(chunk.subarray(0, bytesRead));
      }
      if (
        bootstrapTargetOffset !== undefined &&
        offset >= bootstrapTargetOffset &&
        pendingUpdate.length === 0 &&
        !discardingOversizedUpdate
      ) {
        bootstrapUpdatesComplete = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await locateRelocatedSession();
        if (bootstrapTargetOffset === undefined) {
          try {
            bootstrapTargetOffset = (await stat(currentUpdatesPath)).size;
          } catch (relocatedError) {
            if ((relocatedError as NodeJS.ErrnoException).code === 'ENOENT') {
              // No durable log existed at adoption, so any later file content
              // is live rather than replayed history.
              bootstrapTargetOffset = 0;
              bootstrapUpdatesComplete = true;
            } else {
              report(relocatedError);
            }
          }
        }
      } else report(error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };

  const pollSignals = async (): Promise<void> => {
    const signalsPath = options.signalsPath ?? join(currentSessionDirectory, 'signals.json');
    try {
      const raw = await readFile(signalsPath, 'utf8');
      let signals: GrokSignals;
      try {
        signals = JSON.parse(raw) as GrokSignals;
      } catch {
        // Grok replaces this file in place. A partial rewrite is transient and
        // must be retried on the next poll rather than surfaced as corruption.
        return;
      }

      const compactionCount = signals.compactionCount;
      const compacted =
        typeof compactionCount === 'number' &&
        typeof lastCompactionCount === 'number' &&
        compactionCount > lastCompactionCount;
      if (typeof compactionCount === 'number') lastCompactionCount = compactionCount;

      const usedTokens = signals.contextTokensUsed;
      const capacityTokens = signals.contextWindowTokens;
      if (
        typeof usedTokens !== 'number' ||
        !Number.isFinite(usedTokens) ||
        usedTokens < 0 ||
        typeof capacityTokens !== 'number' ||
        !Number.isFinite(capacityTokens) ||
        capacityTokens <= 0
      ) {
        if (compacted) {
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
      const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as GrokSummary;
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
    polling = Promise.all([pollUpdates(), pollSignals(), pollSummary()])
      .then(() => {
        if (bootstrapUpdatesComplete) bootstrap = false;
      })
      .finally(() => {
        polling = undefined;
      });
    return polling;
  };

  const interval = setInterval(() => void poll(), options.pollIntervalMs ?? 75);
  interval.unref?.();

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
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      eventListeners.clear();
      errorListeners.clear();
    },
  };
}
