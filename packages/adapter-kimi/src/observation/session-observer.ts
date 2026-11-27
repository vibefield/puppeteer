/** Append-safe observer for Kimi Code's session index and wire 1.5 journals. */

import { open, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { AgentEvent, AgentEventConfidence, AgentEventSource } from '@vibefield/puppeteer-core';
import { KimiWireNormalizer } from '../normalization/pipeline.js';
import {
  findKimiAgentJournals,
  listKimiSessionsForCwd,
  type KimiJournalOffsets,
  type KimiSessionLocation,
} from './session-store.js';

export interface KimiObservedEvent {
  event: AgentEvent;
  promptId?: string | undefined;
  turnId?: string | undefined;
  timestamp?: string | undefined;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  replay?: boolean | undefined;
  nativeEvent: unknown;
}

/** One valid durable wire record, before category normalization. */
export interface KimiObservedRecord {
  agentId: string;
  record: unknown;
  timestamp?: string | undefined;
  replay: boolean;
  /** Byte range in the agent-local journal, including the trailing newline. */
  cursorStart: number;
  cursorEnd: number;
}

export type KimiPromptEchoResult =
  { matched: true; sessionId: string; text: string } | { matched: false; reason: string };

export interface KimiPromptExpectation {
  promise: Promise<KimiPromptEchoResult>;
  cancel(): void;
}

export interface KimiSessionObserver {
  sessionId(): string | undefined;
  sessionDirectory(): string | undefined;
  onEvent(listener: (event: KimiObservedEvent) => void): () => void;
  onRecord(listener: (record: KimiObservedRecord) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onBind(listener: (location: KimiSessionLocation) => void): () => void;
  expectPrompt(text: string, timeoutMs: number): KimiPromptExpectation;
  poll(): Promise<void>;
  stop(): Promise<void>;
}

export interface KimiSessionObserverOptions {
  kimiHome: string;
  cwd: string;
  /** Known resume location. Fresh lazy sessions omit this and use discovery. */
  location?: KimiSessionLocation | undefined;
  /** Session ids visible before the fresh native process was launched. */
  baselineSessionIds?: ReadonlySet<string> | undefined;
  /** Per-journal sizes captured before a resumed TUI launch. */
  replayOffsets?: KimiJournalOffsets | undefined;
  /**
   * The run owns this Kimi home (a managed profile's): only its runs start sessions there. The provider sets it;
   * a person's own home is never owned. With no host prompt waiting, only a fresh run in an owned home binds the one
   * new candidate with a typed prompt; elsewhere a fresh run binds only by its host prompt's echo (see
   * `pollDiscovery`).
   */
  ownedRoot?: boolean | undefined;
  pollIntervalMs?: number | undefined;
  readChunkBytes?: number | undefined;
  maxRecordBytes?: number | undefined;
  maxBytesPerPoll?: number | undefined;
  maxReplayBytes?: number | undefined;
  maxDiscoveryBytes?: number | undefined;
}

interface JournalState {
  agentId: string;
  path: string;
  offset: number;
  replayBoundary: number;
  pending: Buffer;
  discarding: boolean;
  skipInitialFragment: boolean;
  normalizer: KimiWireNormalizer;
}

interface PromptWaiter {
  id: number;
  text: string;
  resolve(result: KimiPromptEchoResult): void;
  timeout: ReturnType<typeof setTimeout>;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function promptText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((part) => {
      const item = asRecord(part);
      if (item?.type === 'text' && typeof item.text === 'string') return item.text;
      if (item?.type === 'shell' && typeof item.command === 'string') return item.command;
      return '';
    })
    .join('');
  return text.length > 0 ? text : undefined;
}

function isUserPrompt(record: Record<string, unknown>): boolean {
  if (record.type !== 'turn.prompt') return false;
  const origin = asRecord(record.origin);
  return origin?.kind === 'user' || record.origin === 'user';
}

async function candidatePrompts(path: string, maxBytes: number): Promise<string[]> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const size = (await handle.stat()).size;
    const length = Math.min(size, maxBytes);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, 0);
    const prompts: string[] = [];
    for (const line of bytes.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        const body = asRecord(parsed);
        if (!body || !isUserPrompt(body)) continue;
        const text = promptText(body.input);
        if (text !== undefined) prompts.push(text);
      } catch {
        // A partial tail is expected while the candidate is being written.
      }
    }
    return prompts;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** One observer's claim in a workspace it shares with the other observers of this process. */
interface KimiDiscovery {
  baseline: Set<string>;
  boundSessionId?: string | undefined;
}

// Observers of one Kimi home and folder must not claim each other's sessions. A session a peer bound joins every
// other observer's baseline, so it is never a candidate again; each remembers claims made during its lifetime, even
// after the claiming observer stops, so a delayed launch cannot adopt an older peer's session.
const discoveriesByWorkspace = new Map<string, Set<KimiDiscovery>>();

function stateTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const result = new Date(value);
  return Number.isNaN(result.valueOf()) ? undefined : result.toISOString();
}

export function createKimiSessionObserver(options: KimiSessionObserverOptions): KimiSessionObserver {
  const eventListeners = new Set<(event: KimiObservedEvent) => void>();
  const recordListeners = new Set<(record: KimiObservedRecord) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  const bindListeners = new Set<(location: KimiSessionLocation) => void>();
  const promptWaiters = new Map<number, PromptWaiter>();
  const journals = new Map<string, JournalState>();
  const baseline = new Set(options.baselineSessionIds ?? []);
  const workspace = `${resolve(options.kimiHome)}\0${resolve(options.cwd)}`;
  const discoveries = discoveriesByWorkspace.get(workspace) ?? new Set<KimiDiscovery>();
  const discovery: KimiDiscovery = { baseline, boundSessionId: options.location?.sessionId };
  for (const peer of discoveries) {
    if (peer.boundSessionId) baseline.add(peer.boundSessionId);
    if (discovery.boundSessionId) peer.baseline.add(discovery.boundSessionId);
  }
  discoveries.add(discovery);
  discoveriesByWorkspace.set(workspace, discoveries);
  const replayOffsets = options.replayOffsets ?? new Map<string, number>();
  const readChunkBytes = Math.max(1, Math.floor(options.readChunkBytes ?? 64 * 1024));
  const maxRecordBytes = Math.max(readChunkBytes, Math.floor(options.maxRecordBytes ?? 1024 * 1024));
  const maxBytesPerPoll = Math.max(readChunkBytes, Math.floor(options.maxBytesPerPoll ?? 4 * 1024 * 1024));
  const maxReplayBytes = Math.max(readChunkBytes, Math.floor(options.maxReplayBytes ?? 16 * 1024 * 1024));
  const maxDiscoveryBytes = Math.max(readChunkBytes, Math.floor(options.maxDiscoveryBytes ?? 4 * 1024 * 1024));
  let bound = options.location;
  let bootstrapped = false;
  let stopped = false;
  let polling: Promise<void> | undefined;
  let waiterSequence = 0;
  let ambiguityFingerprint: string | undefined;

  const report = (error: unknown): void => {
    if (stopped) return;
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const listener of errorListeners) {
      try {
        listener(normalized);
      } catch {
        // A consumer fault must not stop journal observation.
      }
    }
  };

  const emit = (event: KimiObservedEvent): void => {
    if (stopped) return;
    for (const listener of eventListeners) {
      try {
        listener(event);
      } catch {
        // A consumer fault must not stop journal observation.
      }
    }
  };

  const emitRecord = (observed: KimiObservedRecord): void => {
    if (stopped) return;
    for (const listener of recordListeners) {
      try {
        listener(observed);
      } catch {
        // A semantic consumer fault must not stop durable observation.
      }
    }
  };

  const settleWaiter = (waiter: PromptWaiter, result: KimiPromptEchoResult): void => {
    if (!promptWaiters.delete(waiter.id)) return;
    clearTimeout(waiter.timeout);
    waiter.resolve(result);
  };

  const settleAllUnmatched = (reason: string): void => {
    for (const waiter of [...promptWaiters.values()]) settleWaiter(waiter, { matched: false, reason });
  };

  const observePrompt = (text: string): void => {
    if (!bound) return;
    for (const waiter of [...promptWaiters.values()]) {
      if (waiter.text === text) settleWaiter(waiter, { matched: true, sessionId: bound.sessionId, text });
    }
  };

  const bootstrap = async (): Promise<void> => {
    if (!bound || bootstrapped || stopped) return;
    bootstrapped = true;
    let state: Record<string, unknown> | undefined;
    try {
      state = asRecord(JSON.parse(await readFile(bound.statePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) report(error);
    }
    emit({
      event: {
        type: 'session:started',
        nativeSessionId: bound.sessionId,
        ...(typeof state?.title === 'string' ? { title: state.title } : {}),
        startSource: 'native-wire-bind',
      },
      timestamp: stateTimestamp(state?.createdAt),
      source: 'native-log',
      confidence: 'authoritative',
      nativeEvent: state ?? { sessionId: bound.sessionId, sessionDir: bound.sessionDir },
    });
    const currentCwd =
      typeof state?.cwd === 'string' ? state.cwd : typeof state?.workDir === 'string' ? state.workDir : bound.workDir;
    emit({
      event: { type: 'environment:updated', currentCwd },
      source: 'native-log',
      confidence: 'authoritative',
      nativeEvent: state ?? { sessionId: bound.sessionId, sessionDir: bound.sessionDir },
    });
    for (const listener of bindListeners) {
      try {
        listener(bound);
      } catch {
        // Binding is already committed; listener failure cannot undo it.
      }
    }
  };

  const bind = async (location: KimiSessionLocation): Promise<void> => {
    if (bound || stopped || baseline.has(location.sessionId)) return;
    // Claimed before anything is said under it: the id is this run's from here (`sessionId()`), and no peer's.
    bound = location;
    discovery.boundSessionId = location.sessionId;
    for (const peer of discoveries) {
      if (peer !== discovery) peer.baseline.add(location.sessionId);
    }
    await bootstrap();
  };

  /**
   * Binds a fresh run to the one new session that is its own. Every candidate is new to this run and claimed by no
   * peer (a peer's bind removes it), and holds a prompt the person typed. A prompt the host sent and waits for picks
   * the candidate that echoes it. With none waiting, only a run in a home it owns binds: there the one candidate
   * binds, and two or more stand ambiguous, said once per set of candidates and judged again at every poll, so one
   * that a peer binds leaves the other to bind.
   *
   * In a home the run does not own, a new session that holds none of the run's host prompts may be one a person
   * started in another terminal in the same folder, so with no host prompt waiting nothing binds there. Binding once
   * input has been written to the run's own terminal since its spawn would also be sound, but no host surface reports
   * that input to an adapter: such a run binds only by its host prompt's echo, and a run a person only types into
   * stays provisional.
   */
  const pollDiscovery = async (): Promise<void> => {
    const candidates = (await listKimiSessionsForCwd(options.kimiHome, options.cwd)).filter(
      (candidate) => !baseline.has(candidate.sessionId),
    );
    if (candidates.length === 0) {
      ambiguityFingerprint = undefined;
      return;
    }

    // Judged on the prompts waiting now: one can settle while the folder is listed.
    const expected = new Set([...promptWaiters.values()].map((waiter) => waiter.text));
    if (expected.size === 0 && options.ownedRoot !== true) return;
    const matches: KimiSessionLocation[] = [];
    for (const candidate of candidates) {
      const prompts = await candidatePrompts(candidate.wirePath, maxDiscoveryBytes);
      if (prompts.length === 0) continue;
      if (expected.size === 0 || prompts.some((text) => expected.has(text))) matches.push(candidate);
    }
    if (matches.length === 1) {
      await bind(matches[0]!);
      return;
    }
    if (matches.length < 2) return;
    const fingerprint = matches
      .map((item) => item.sessionId)
      .sort()
      .join(':');
    if (fingerprint !== ambiguityFingerprint) {
      ambiguityFingerprint = fingerprint;
      const message = `Kimi session discovery is ambiguous: ${matches.map((item) => item.sessionId).join(', ')}`;
      report(new Error(message));
      emit({
        event: { type: 'adapter:native-event', adapter: 'kimi', nativeType: 'session-discovery-ambiguous' },
        source: 'runtime',
        confidence: 'authoritative',
        nativeEvent: {
          candidates: matches.map((item) => ({ sessionId: item.sessionId, sessionDir: item.sessionDir })),
        },
      });
      settleAllUnmatched(message);
    }
  };

  const emitInvalidLine = (journal: JournalState, line: Buffer, reason: string, replay: boolean): void => {
    report(new Error(`invalid Kimi wire record in ${journal.path}: ${reason}`));
    emit({
      event: { type: 'adapter:native-event', adapter: 'kimi', nativeType: 'invalid-wire-record' },
      source: 'native-log',
      confidence: 'authoritative',
      replay,
      nativeEvent: { agentId: journal.agentId, raw: line.toString('utf8'), reason },
    });
  };

  const normalizeLine = (journal: JournalState, line: Buffer, lineEnd: number): void => {
    if (line.length === 0 || stopped) return;
    const replay = lineEnd <= journal.replayBoundary;
    const lineStart = lineEnd - line.length - 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString('utf8')) as unknown;
    } catch (error) {
      emitInvalidLine(journal, line, error instanceof Error ? error.message : String(error), replay);
      return;
    }
    const body = asRecord(parsed);
    emitRecord({
      agentId: journal.agentId,
      record: parsed,
      timestamp: stateTimestamp(body?.time ?? body?.created_at),
      replay,
      cursorStart: lineStart,
      cursorEnd: lineEnd,
    });
    if (journal.agentId === 'main' && body && isUserPrompt(body)) {
      const text = promptText(body.input);
      if (text !== undefined && !replay) observePrompt(text);
    }
    const normalized = journal.normalizer.normalize(parsed, { agentId: journal.agentId });
    for (const event of normalized.events) {
      emit({
        event,
        promptId: normalized.promptId,
        turnId: normalized.turnId,
        timestamp: normalized.timestamp,
        source: normalized.source,
        confidence: normalized.confidence,
        replay,
        nativeEvent: {
          agentId: journal.agentId,
          record: normalized.nativeEvent,
          cursorStart: lineStart,
          cursorEnd: lineEnd,
        },
      });
    }
  };

  const consumeBytes = (journal: JournalState, chunk: Buffer, chunkStart: number): void => {
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor);
      const end = newline < 0 ? chunk.length : newline;
      const fragment = chunk.subarray(cursor, end);
      const lineEnd = chunkStart + end + (newline < 0 ? 0 : 1);

      if (journal.skipInitialFragment || journal.discarding) {
        if (newline < 0) return;
        journal.skipInitialFragment = false;
        journal.discarding = false;
        cursor = newline + 1;
        continue;
      }

      if (journal.pending.length + fragment.length > maxRecordBytes) {
        report(new Error(`Kimi wire record exceeds the ${maxRecordBytes}-byte safety limit in ${journal.path}`));
        emit({
          event: { type: 'adapter:native-event', adapter: 'kimi', nativeType: 'oversized-wire-record' },
          source: 'native-log',
          confidence: 'authoritative',
          replay: lineEnd <= journal.replayBoundary,
          nativeEvent: { agentId: journal.agentId, path: journal.path, maxRecordBytes },
        });
        journal.pending = Buffer.alloc(0);
        if (newline < 0) journal.discarding = true;
      } else if (newline < 0) {
        journal.pending =
          journal.pending.length === 0 ? Buffer.from(fragment) : Buffer.concat([journal.pending, fragment]);
      } else {
        const complete = journal.pending.length === 0 ? fragment : Buffer.concat([journal.pending, fragment]);
        journal.pending = Buffer.alloc(0);
        normalizeLine(journal, complete, lineEnd);
      }
      if (newline < 0) return;
      cursor = newline + 1;
    }
  };

  const ensureJournals = async (): Promise<void> => {
    if (!bound) return;
    for (const descriptor of await findKimiAgentJournals(bound.sessionDir)) {
      if (journals.has(descriptor.path)) continue;
      const replayBoundary = replayOffsets.get(descriptor.path) ?? 0;
      const offset = replayBoundary > maxReplayBytes ? replayBoundary - maxReplayBytes : 0;
      journals.set(descriptor.path, {
        ...descriptor,
        offset,
        replayBoundary,
        pending: Buffer.alloc(0),
        discarding: false,
        skipInitialFragment: offset > 0,
        normalizer: new KimiWireNormalizer(),
      });
      if (offset > 0) {
        emit({
          event: { type: 'adapter:native-event', adapter: 'kimi', nativeType: 'replay-window-truncated' },
          source: 'runtime',
          confidence: 'authoritative',
          replay: true,
          nativeEvent: { agentId: descriptor.agentId, path: descriptor.path, omittedBytes: offset },
        });
      }
    }
  };

  const pollJournal = async (journal: JournalState): Promise<void> => {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(journal.path, 'r');
      const info = await handle.stat();
      if (info.size < journal.offset) {
        report(new Error(`Kimi wire journal was truncated: ${journal.path}`));
        journal.offset = 0;
        journal.pending = Buffer.alloc(0);
        journal.discarding = false;
        journal.skipInitialFragment = false;
      }
      let remaining = Math.min(info.size - journal.offset, maxBytesPerPoll);
      while (remaining > 0 && !stopped) {
        const requested = Math.min(readChunkBytes, remaining);
        const bytes = Buffer.allocUnsafe(requested);
        const start = journal.offset;
        const { bytesRead } = await handle.read(bytes, 0, requested, start);
        if (bytesRead === 0) break;
        journal.offset += bytesRead;
        remaining -= bytesRead;
        consumeBytes(journal, bytes.subarray(0, bytesRead), start);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report(error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };

  const doPoll = async (): Promise<void> => {
    if (!bound) await pollDiscovery();
    if (!bound || stopped) return;
    await bootstrap();
    await ensureJournals();
    for (const journal of journals.values()) await pollJournal(journal);
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    if (polling) return polling;
    polling = doPoll()
      .catch(report)
      .finally(() => {
        polling = undefined;
      });
    return polling;
  };

  const interval = setInterval(() => void poll(), options.pollIntervalMs ?? 75);
  interval.unref?.();

  return {
    sessionId: () => bound?.sessionId,
    sessionDirectory: () => bound?.sessionDir,
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onRecord(listener) {
      recordListeners.add(listener);
      return () => recordListeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    onBind(listener) {
      bindListeners.add(listener);
      return () => bindListeners.delete(listener);
    },
    expectPrompt(text, timeoutMs) {
      waiterSequence += 1;
      const id = waiterSequence;
      let waiter: PromptWaiter;
      const promise = new Promise<KimiPromptEchoResult>((resolve) => {
        const timeout = setTimeout(
          () => {
            const current = promptWaiters.get(id);
            if (current) settleWaiter(current, { matched: false, reason: 'native prompt echo timed out' });
          },
          Math.max(1, timeoutMs),
        );
        timeout.unref?.();
        waiter = { id, text, resolve, timeout };
        promptWaiters.set(id, waiter);
      });
      return {
        promise,
        cancel() {
          const current = promptWaiters.get(id);
          if (current) settleWaiter(current, { matched: false, reason: 'prompt expectation cancelled' });
        },
      };
    },
    poll,
    async stop() {
      if (stopped) return;
      clearInterval(interval);
      // Drain one final bounded read while listeners and normalization state
      // are still live. The host owns process lifecycle, so it must dispose
      // after terminal exit to make this an exit drain rather than merely a
      // caller-requested final poll.
      await polling?.catch(() => undefined);
      await poll().catch(() => undefined);
      stopped = true;
      settleAllUnmatched('Kimi observer disposed before native prompt echo');
      discoveries.delete(discovery);
      if (discoveries.size === 0) discoveriesByWorkspace.delete(workspace);
      eventListeners.clear();
      recordListeners.clear();
      errorListeners.clear();
      bindListeners.clear();
      journals.clear();
    },
  };
}
