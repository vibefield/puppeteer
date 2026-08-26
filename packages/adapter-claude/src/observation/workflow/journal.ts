import { open, readdir, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { basename, dirname, join } from 'node:path';
import type { WorkflowMember, WorkflowUpdatedEvent } from '@vibecook/puppeteer-core';

const DEFAULT_RUNNING_IDLE_MS = 20 * 60_000;
const DEFAULT_MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_WORKFLOWS = 1_024;
const DEFAULT_MAX_MEMBERS = 2_048;

interface JournalMember {
  agentId: string;
  agentType?: string;
  done: boolean;
}

interface JournalState {
  offset: number;
  lastMtimeMs?: number;
  pending: string;
  decoder: StringDecoder;
  discardLeadingPartial: boolean;
  members: Map<string, JournalMember>;
}

export interface ClaudeWorkflowJournalObservation {
  event: WorkflowUpdatedEvent;
  timestamp: string;
  nativeEvent: { journal: 'journal.jsonl'; workflowId: string };
}

export interface ClaudeWorkflowJournalObserver {
  read(options?: { nowMs?: number; runningIdleMs?: number }): Promise<ClaudeWorkflowJournalObservation[]>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function workflowDirectory(transcriptPath: string, nativeSessionId: string): string {
  if (
    !nativeSessionId ||
    basename(nativeSessionId) !== nativeSessionId ||
    nativeSessionId === '.' ||
    nativeSessionId === '..'
  ) {
    throw new RangeError('Claude native session id is not a safe directory name');
  }
  return join(dirname(transcriptPath), nativeSessionId, 'subagents', 'workflows');
}

function freshState(offset = 0): JournalState {
  return {
    offset,
    pending: '',
    decoder: new StringDecoder('utf8'),
    discardLeadingPartial: offset > 0,
    members: new Map(),
  };
}

function acceptLine(state: JournalState, line: string, maxMembers: number): boolean {
  if (!line.trim()) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  const entry = object(parsed);
  const agentId = string(entry?.agentId ?? entry?.agent_id);
  if (!entry || !agentId) return true;
  const previous = state.members.get(agentId);
  const agentType = string(entry.agentType ?? entry.agent_type ?? entry.name) ?? previous?.agentType;
  if (!previous && state.members.size >= maxMembers) {
    const oldest = state.members.keys().next().value as string | undefined;
    if (oldest) state.members.delete(oldest);
  }
  if (entry.type === 'started') {
    state.members.set(agentId, { agentId, ...(agentType ? { agentType } : {}), done: false });
  } else if (entry.type === 'result') {
    state.members.set(agentId, { agentId, ...(agentType ? { agentType } : {}), done: true });
  }
  return true;
}

async function readJournal(
  journalPath: string,
  state: JournalState,
  maxBytes: number,
  maxMembers: number,
): Promise<{ state: JournalState; mtimeMs: number } | undefined> {
  let metadata;
  try {
    metadata = await stat(journalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!metadata.isFile()) return undefined;
  if (
    metadata.size < state.offset ||
    (metadata.size === state.offset && state.lastMtimeMs !== undefined && metadata.mtimeMs !== state.lastMtimeMs)
  ) {
    state = freshState(Math.max(0, metadata.size - maxBytes));
  }
  if (metadata.size - state.offset > maxBytes) state = freshState(metadata.size - maxBytes);
  if (
    metadata.size === state.offset &&
    metadata.mtimeMs === state.lastMtimeMs &&
    state.pending &&
    !state.discardLeadingPartial &&
    acceptLine(state, state.pending, maxMembers)
  ) {
    state.pending = '';
    state.decoder = new StringDecoder('utf8');
  }
  if (metadata.size > state.offset) {
    const handle = await open(journalPath, 'r');
    try {
      const length = metadata.size - state.offset;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, state.offset);
      state.offset += bytesRead;
      const parts = (state.pending + state.decoder.write(buffer.subarray(0, bytesRead))).split('\n');
      state.pending = parts.pop() ?? '';
      if (state.discardLeadingPartial && parts.length > 0) {
        parts.shift();
        state.discardLeadingPartial = false;
      }
      for (const line of parts) acceptLine(state, line, maxMembers);
      if (Buffer.byteLength(state.pending) > maxBytes) {
        state.pending = '';
        state.decoder = new StringDecoder('utf8');
        state.discardLeadingPartial = true;
      }
    } finally {
      await handle.close();
    }
  }
  state.lastMtimeMs = metadata.mtimeMs;
  return { state, mtimeMs: metadata.mtimeMs };
}

/** Incremental, bounded reader for journals under one exact native session. */
export function createClaudeWorkflowJournalObserver(
  transcriptPath: string,
  nativeSessionId: string,
  options: { maxJournalBytes?: number; maxWorkflows?: number; maxMembers?: number } = {},
): ClaudeWorkflowJournalObserver {
  const root = workflowDirectory(transcriptPath, nativeSessionId);
  const maxJournalBytes = options.maxJournalBytes ?? DEFAULT_MAX_JOURNAL_BYTES;
  const maxWorkflows = options.maxWorkflows ?? DEFAULT_MAX_WORKFLOWS;
  const maxMembers = options.maxMembers ?? DEFAULT_MAX_MEMBERS;
  if (!Number.isSafeInteger(maxJournalBytes) || maxJournalBytes < 1) {
    throw new RangeError('workflow journal maxJournalBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxWorkflows) || maxWorkflows < 1) {
    throw new RangeError('workflow journal maxWorkflows must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxMembers) || maxMembers < 1) {
    throw new RangeError('workflow journal maxMembers must be a positive safe integer');
  }
  const states = new Map<string, JournalState>();

  return {
    async read(readOptions = {}) {
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const workflowIds = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .slice(0, maxWorkflows);
      const active = new Set(workflowIds);
      for (const workflowId of states.keys()) {
        if (!active.has(workflowId)) states.delete(workflowId);
      }

      const nowMs = readOptions.nowMs ?? Date.now();
      const runningIdleMs = readOptions.runningIdleMs ?? DEFAULT_RUNNING_IDLE_MS;
      if (!Number.isFinite(nowMs)) throw new RangeError('workflow journal nowMs must be finite');
      if (!Number.isFinite(runningIdleMs) || runningIdleMs < 0) {
        throw new RangeError('workflow journal runningIdleMs must be a non-negative finite number');
      }
      const observations: ClaudeWorkflowJournalObservation[] = [];
      for (const workflowId of workflowIds) {
        const result = await readJournal(
          join(root, workflowId, 'journal.jsonl'),
          states.get(workflowId) ?? freshState(),
          maxJournalBytes,
          maxMembers,
        );
        if (!result) continue;
        states.set(workflowId, result.state);
        if (result.state.members.size === 0) continue;
        const stale = nowMs - result.mtimeMs > runningIdleMs;
        const members: WorkflowMember[] = [...result.state.members.values()]
          .map(({ agentId, agentType, done }) => ({
            agentId,
            ...(agentType ? { agentType } : {}),
            state: done || stale ? ('completed' as const) : ('active' as const),
          }))
          .sort((left, right) => left.agentId.localeCompare(right.agentId));
        observations.push({
          event: {
            type: 'workflow:updated',
            workflowId,
            active: members.some(({ state }) => state === 'active'),
            members,
          },
          timestamp: new Date(result.mtimeMs).toISOString(),
          nativeEvent: { journal: 'journal.jsonl', workflowId },
        });
      }
      return observations;
    },
  };
}

/** One-shot compatibility helper; long-lived providers should reuse the observer. */
export function observeClaudeWorkflowJournals(
  transcriptPath: string,
  nativeSessionId: string,
  options: { nowMs?: number; runningIdleMs?: number } = {},
): Promise<ClaudeWorkflowJournalObservation[]> {
  return createClaudeWorkflowJournalObserver(transcriptPath, nativeSessionId).read(options);
}
