import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { WorkflowMember, WorkflowUpdatedEvent } from '@vibecook/puppeteer-core';

const DEFAULT_RUNNING_IDLE_MS = 20 * 60_000;

interface JournalMember {
  agentId: string;
  agentType?: string;
  done: boolean;
}

export interface ClaudeWorkflowJournalObservation {
  event: WorkflowUpdatedEvent;
  timestamp: string;
  nativeEvent: { journal: 'journal.jsonl'; workflowId: string };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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

async function parseJournal(
  journalPath: string,
  workflowId: string,
  nowMs: number,
  runningIdleMs: number,
): Promise<ClaudeWorkflowJournalObservation | undefined> {
  const [text, metadata] = await Promise.all([readFile(journalPath, 'utf8'), stat(journalPath)]);
  const members = new Map<string, JournalMember>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = object(parsed);
    const agentId = string(entry?.agentId ?? entry?.agent_id);
    if (!entry || !agentId) continue;
    const previous = members.get(agentId);
    const agentType = string(entry.agentType ?? entry.agent_type ?? entry.name) ?? previous?.agentType;
    if (entry.type === 'started') members.set(agentId, { agentId, ...(agentType ? { agentType } : {}), done: false });
    else if (entry.type === 'result')
      members.set(agentId, { agentId, ...(agentType ? { agentType } : {}), done: true });
  }
  if (members.size === 0) return undefined;
  const stale = nowMs - metadata.mtimeMs > runningIdleMs;
  const projected: WorkflowMember[] = [...members.values()]
    .map(({ agentId, agentType, done }) => ({
      agentId,
      ...(agentType ? { agentType } : {}),
      state: done || stale ? ('completed' as const) : ('active' as const),
    }))
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
  return {
    event: {
      type: 'workflow.updated',
      workflowId,
      active: projected.some(({ state }) => state === 'active'),
      members: projected,
    },
    timestamp: metadata.mtime.toISOString(),
    nativeEvent: { journal: 'journal.jsonl', workflowId },
  };
}

/** Read only journals under the transcript's exact native session directory. */
export async function observeClaudeWorkflowJournals(
  transcriptPath: string,
  nativeSessionId: string,
  options: { nowMs?: number; runningIdleMs?: number } = {},
): Promise<ClaudeWorkflowJournalObservation[]> {
  const root = workflowDirectory(transcriptPath, nativeSessionId);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const observations = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        parseJournal(
          join(root, entry.name, 'journal.jsonl'),
          entry.name,
          options.nowMs ?? Date.now(),
          options.runningIdleMs ?? DEFAULT_RUNNING_IDLE_MS,
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        }),
      ),
  );
  return observations.filter((value): value is ClaudeWorkflowJournalObservation => value !== undefined);
}
