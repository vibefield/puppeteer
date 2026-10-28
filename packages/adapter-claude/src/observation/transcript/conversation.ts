import type { AgentEvent, AssistantMessageEvent } from '@vibefield/puppeteer-core';
import {
  claudeQuestionRequestId,
  normalizeClaudeQuestionRequested,
  parseClaudeStructuredQuestions,
} from '../../normalization/interaction.js';
import { normalizeClaudeToolRequested } from '../../normalization/tool.js';
import type { SemanticObservationEvent } from '../semantic-provider.js';
import {
  safeTranscriptEvidence,
  transcriptContent,
  transcriptObject,
  transcriptRecordId,
  transcriptString,
  transcriptText,
  type ClaudeTranscriptRecord,
} from './wire.js';

/**
 * The native `turnOrigin` values of a turn a person started: a typed TUI prompt (`human`) or a
 * print-mode / Agent SDK prompt (`sdk`). 2.1.308's own user-started test accepts exactly these;
 * every other value (`scheduled`, `task_notification`, `auto_continuation`, `peer`,
 * `host_synthetic`, `system`, `unknown`) is a turn Claude or its host injected.
 */
const USER_STARTED_TURN_ORIGINS: ReadonlySet<string> = new Set(['human', 'sdk']);

/** Text heuristic for rows without a native `turnOrigin` (see {@link opensUserTurn}). */
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

/**
 * Whether a `user` row is a person's prompt that opens a turn. A compaction summary never is: it
 * continues the turn it interrupted, and auto/prompt-too-long compactions stamp that turn's
 * `turnOrigin` onto it. Otherwise the row's native `turnOrigin` decides when present, whatever its
 * text. Rows without one (transcripts before the field, and the 2.1.308 rows that carry none) keep
 * the synthetic-preamble heuristic. The decision stays a property of the row: the projection runs
 * over a sliding window of a file that a resumed session may have begun under an older version,
 * and a transcript-wide switch would re-key earlier answers' turns (re-announcing them as live)
 * once the first row carrying the field arrived.
 */
function opensUserTurn(record: ClaudeTranscriptRecord): boolean {
  if (
    transcriptContent(record).some((value) => {
      const block = transcriptObject(value);
      return block?.type === 'tool_result';
    })
  ) {
    return false;
  }
  if (record.isCompactSummary) return false;
  if (record.turnOrigin !== undefined) return USER_STARTED_TURN_ORIGINS.has(record.turnOrigin);
  return stripSyntheticUserPreamble(transcriptText(record)) !== undefined;
}

function observation(
  event: AgentEvent,
  source: ClaudeTranscriptRecord,
  options: { turnId?: string | undefined } = {},
): SemanticObservationEvent {
  return {
    event,
    timestamp: source.timestamp,
    ...(options.turnId ? { promptId: options.turnId, turnId: options.turnId } : {}),
    ...(source.agentId ? { agentId: source.agentId } : {}),
    ...(source.agentType ? { agentType: source.agentType } : {}),
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
      // `children` and `indegree` are both sized from `records`, so a child index is always in range.
      const degree = indegree[child];
      if (degree === undefined) continue;
      indegree[child] = degree - 1;
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

/** Extract root assistant messages for live observation without synthesizing historical turns. */
export function projectClaudeTranscriptAssistants(
  records: readonly ClaudeTranscriptRecord[],
): ReadonlyMap<string, SemanticObservationEvent> {
  const assistants = new Map<string, SemanticObservationEvent>();
  let turnId: string | undefined;

  for (const record of causalOrder(records)) {
    if (record.isSidechain) continue;
    // The row type decides, never `message.role`: 2.1.308's `api-request-blob` bookkeeping rows
    // carry a user or assistant role and are neither a prompt nor a reply.
    if (record.type === 'user') {
      if (opensUserTurn(record)) turnId = transcriptRecordId(record);
      continue;
    }
    if (record.type !== 'assistant') continue;
    const projected = assistant(record, turnId);
    if (!projected) continue;
    const key = transcriptRecordId(record);
    assistants.set(key, projected);
  }
  return assistants;
}

/** A `tool_use` block's id, name and input, when the content block is one. */
function toolUse(value: unknown): { id: string; name: string; input: unknown } | undefined {
  const block = transcriptObject(value);
  if (block?.type !== 'tool_use') return undefined;
  const id = transcriptString(block.id);
  const name = transcriptString(block.name);
  return id && name ? { id, name, input: block.input } : undefined;
}

/** The tool calls a `user` row answers: the ids its `tool_result` blocks name. */
function answeredToolIds(record: ClaudeTranscriptRecord): string[] {
  return transcriptContent(record).flatMap((value) => {
    const block = transcriptObject(value);
    const id = block?.type === 'tool_result' ? transcriptString(block.tool_use_id) : undefined;
    return id ? [id] : [];
  });
}

/**
 * What the transcript shows still open at its end: the root turn the agent is in, and the tools it requested in that
 * turn whose results it has not written. An attach reads it once (the re-attach study, §3.3), so a Claude that was
 * mid-turn when its host restarted shows it, instead of nothing until its next hook.
 *
 * Only what the rows prove is read as open:
 * - A `tool_use` block that no later `tool_result` names. The tool is running or waiting on a permission, and the
 *   transcript does not say which, so it is read as a running tool. An AskUserQuestion call is also its question.
 * - A turn whose last root message is a `tool_result` (the model owes the next step), or is the prompt itself when the
 *   prompt carries a native user-started `turnOrigin` (2.1.283+). An interruption writes a marker row after either,
 *   and the marker carries no `turnOrigin`, so a turn ended by Esc reads closed.
 *
 * Everything else reads closed: a turn whose last root message is assistant text (finished, or about to request a
 * tool), and every prompt of a transcript older than `turnOrigin`. The next hook corrects a closed reading. A wrong
 * open one would show a working agent that is not, so the rules lean closed.
 */
export function projectClaudeTranscriptOpenWork(
  records: readonly ClaudeTranscriptRecord[],
): SemanticObservationEvent[] {
  let prompt: ClaudeTranscriptRecord | undefined;
  let owed = false;
  const tools = new Map<string, { record: ClaudeTranscriptRecord; name: string; input: unknown }>();
  for (const record of causalOrder(records)) {
    if (record.isSidechain) continue;
    if (record.type === 'user') {
      const answered = answeredToolIds(record);
      if (answered.length > 0) {
        for (const id of answered) tools.delete(id);
        owed = true;
      } else if (opensUserTurn(record)) {
        prompt = record;
        tools.clear();
        owed = record.turnOrigin !== undefined;
      } else {
        owed = false;
      }
      continue;
    }
    if (record.type !== 'assistant') continue;
    for (const value of transcriptContent(record)) {
      const tool = toolUse(value);
      if (tool) tools.set(tool.id, { record, name: tool.name, input: tool.input });
    }
    owed = false;
  }
  if (prompt === undefined || (tools.size === 0 && !owed)) return [];
  const turnId = prompt.promptId ?? transcriptRecordId(prompt);
  const open = [observation({ type: 'turn:started', turnId, prompt: transcriptText(prompt) }, prompt, { turnId })];
  for (const [id, tool] of tools) {
    open.push(observation(normalizeClaudeToolRequested(id, tool.name, tool.input), tool.record, { turnId }));
    const questions =
      tool.name.toLowerCase() === 'askuserquestion' ? parseClaudeStructuredQuestions(tool.input) : undefined;
    if (questions) {
      const asked = normalizeClaudeQuestionRequested(claudeQuestionRequestId(id), questions);
      open.push(observation(asked, tool.record, { turnId }));
    }
  }
  return open;
}

export function claudeTranscriptConversationFingerprint(value: SemanticObservationEvent): string {
  return JSON.stringify([value.turnId ?? null, value.event]);
}
