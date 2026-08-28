import type { AgentEvent, AssistantMessageEvent } from '@vibecook/puppeteer-core';
import type { SemanticObservationEvent } from '../semantic-provider.js';
import {
  safeTranscriptEvidence,
  transcriptContent,
  transcriptObject,
  transcriptRecordId,
  transcriptText,
  type ClaudeTranscriptRecord,
} from './wire.js';

const SYNTHETIC_USER_PREFIXES = [
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<command-name>',
  '<command-message>',
  '<task-notification>',
  '<system-reminder>',
  '<ide_opened_file>',
  '<ide_selection>',
] as const;

const SYNTHETIC_USER_TEXT_PREFIXES = ['this session is being continued from a previous conversation'] as const;

function stripSyntheticUserPreamble(value: string): string | undefined {
  let remaining = value.trim();
  for (;;) {
    const lower = remaining.toLowerCase();
    if (SYNTHETIC_USER_TEXT_PREFIXES.some((candidate) => lower.startsWith(candidate))) return undefined;
    const prefix = SYNTHETIC_USER_PREFIXES.find((candidate) => lower.startsWith(candidate));
    if (!prefix) return remaining || undefined;
    const closing = `</${prefix.slice(1, -1)}>`;
    const closingIndex = lower.indexOf(closing, prefix.length);
    if (closingIndex < 0) return undefined;
    remaining = remaining.slice(closingIndex + closing.length).trimStart();
    if (!remaining) return undefined;
  }
}

function userPrompt(record: ClaudeTranscriptRecord): string | undefined {
  if (
    transcriptContent(record).some((value) => {
      const block = transcriptObject(value);
      return block?.type === 'tool_result';
    })
  ) {
    return undefined;
  }
  return stripSyntheticUserPreamble(transcriptText(record));
}

function observation(
  event: AgentEvent,
  source: ClaudeTranscriptRecord,
  options: { turnId?: string; replay?: boolean } = {},
): SemanticObservationEvent {
  return {
    event,
    timestamp: source.timestamp,
    ...(options.turnId ? { promptId: options.turnId, turnId: options.turnId } : {}),
    ...(source.agentId ? { agentId: source.agentId } : {}),
    ...(source.agentType ? { agentType: source.agentType } : {}),
    ...(options.replay ? { replay: true } : {}),
    nativeEvent: safeTranscriptEvidence(source),
  };
}

function assistant(record: ClaudeTranscriptRecord, turnId?: string): SemanticObservationEvent | undefined {
  const text = transcriptText(record);
  if (!text) return undefined;
  const event: AssistantMessageEvent = {
    type: 'conversation:assistant-message',
    messageId: transcriptRecordId(record),
    ...(turnId ? { turnId } : {}),
    text,
    final: true,
    displayOnly: false,
  };
  return observation(event, record, { turnId });
}

/**
 * Claude's transcript is a parent-linked graph. Its append workers can flush
 * rows out of physical order during process teardown, so line order alone is
 * not a trustworthy conversation order. Walk each row's known ancestry first
 * while retaining file order for unrelated rows and malformed cycles.
 */
function causalOrder(records: readonly ClaudeTranscriptRecord[]): ClaudeTranscriptRecord[] {
  const firstIndexByUuid = new Map<string, number>();
  for (const [index, record] of records.entries()) {
    if (record.uuid !== undefined && !firstIndexByUuid.has(record.uuid)) firstIndexByUuid.set(record.uuid, index);
  }
  const children = Array.from({ length: records.length }, () => [] as number[]);
  const indegree = new Uint8Array(records.length);
  for (const [index, record] of records.entries()) {
    const parentIndex = record.parentUuid === undefined ? undefined : firstIndexByUuid.get(record.parentUuid);
    if (parentIndex === undefined || parentIndex === index) continue;
    children[parentIndex]!.push(index);
    indegree[index] = 1;
  }

  const ready: number[] = [];
  const pushReady = (value: number): void => {
    let index = ready.length;
    ready.push(value);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (ready[parent]! <= value) break;
      ready[index] = ready[parent]!;
      index = parent;
    }
    ready[index] = value;
  };
  const popReady = (): number => {
    const value = ready[0]!;
    const tail = ready.pop()!;
    if (ready.length === 0) return value;
    let index = 0;
    while (index * 2 + 1 < ready.length) {
      const left = index * 2 + 1;
      const right = left + 1;
      const child = right < ready.length && ready[right]! < ready[left]! ? right : left;
      if (ready[child]! >= tail) break;
      ready[index] = ready[child]!;
      index = child;
    }
    ready[index] = tail;
    return value;
  };

  for (const [index, degree] of indegree.entries()) {
    if (degree === 0) pushReady(index);
  }
  const ordered: ClaudeTranscriptRecord[] = [];
  const emitted = new Uint8Array(records.length);
  while (ready.length > 0) {
    const index = popReady();
    emitted[index] = 1;
    ordered.push(records[index]!);
    for (const child of children[index]!) {
      indegree[child] -= 1;
      if (indegree[child] === 0) pushReady(child);
    }
  }
  // A corrupt cycle has no valid causal order. Retain its physical order so
  // one malformed branch cannot hide otherwise parseable conversation rows.
  for (const [index, record] of records.entries()) {
    if (emitted[index] === 0) ordered.push(record);
  }
  return ordered;
}

export interface ClaudeTranscriptConversationProjection {
  history: readonly SemanticObservationEvent[];
  assistants: ReadonlyMap<string, SemanticObservationEvent>;
}

/** Project only the root human conversation; sidechains remain usage/workflow evidence, not chat messages. */
export function projectClaudeTranscriptConversation(
  records: readonly ClaudeTranscriptRecord[],
): ClaudeTranscriptConversationProjection {
  const history: SemanticObservationEvent[] = [];
  const assistants = new Map<string, SemanticObservationEvent>();
  let current:
    | {
        turnId: string;
        prompt: string;
        source: ClaudeTranscriptRecord;
        assistants: Array<{ key: string; observation: SemanticObservationEvent; source: ClaudeTranscriptRecord }>;
      }
    | undefined;

  const flush = (boundary: 'next-prompt' | 'snapshot-end'): void => {
    if (!current) return;
    history.push(
      observation({ type: 'turn:started', turnId: current.turnId, prompt: current.prompt }, current.source, {
        turnId: current.turnId,
        replay: true,
      }),
    );
    for (const item of current.assistants) history.push({ ...item.observation, replay: true });
    const last = current.assistants.at(-1);
    history.push(
      observation(
        last
          ? {
              type: 'turn:completed',
              turnId: current.turnId,
              ...(last?.observation.event.type === 'conversation:assistant-message'
                ? { lastAssistantMessage: last.observation.event.text }
                : {}),
            }
          : {
              type: 'turn:failed',
              turnId: current.turnId,
              error:
                boundary === 'next-prompt'
                  ? 'superseded by a newer user prompt before an assistant response'
                  : 'interrupted before an assistant response',
            },
        last?.source ?? current.source,
        { turnId: current.turnId, replay: true },
      ),
    );
    current = undefined;
  };

  for (const record of causalOrder(records)) {
    if (record.isSidechain) continue;
    const role = record.message?.role;
    if (record.type === 'user' || role === 'user') {
      const prompt = userPrompt(record);
      if (!prompt) continue;
      flush('next-prompt');
      current = { turnId: transcriptRecordId(record), prompt, source: record, assistants: [] };
      continue;
    }
    if (record.type !== 'assistant' && role !== 'assistant') continue;
    const projected = assistant(record, current?.turnId);
    if (!projected) continue;
    const key = transcriptRecordId(record);
    assistants.set(key, projected);
    if (current) current.assistants.push({ key, observation: projected, source: record });
  }
  flush('snapshot-end');
  return { history, assistants };
}

export function claudeTranscriptConversationFingerprint(value: SemanticObservationEvent): string {
  return JSON.stringify([value.turnId ?? null, value.event]);
}
