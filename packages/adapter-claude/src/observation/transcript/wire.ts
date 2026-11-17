/** Minimal, tolerant model of the Claude transcript rows this adapter consumes. */

/**
 * A content block, reduced at decode to what the projections read: a text block's text; a `tool_use` block whole,
 * because its input is the open tool's input at an attach and the hook rail's correlation key; and a `tool_result`
 * block's `tool_use_id`, never its body (Read and Bash output, screenshots). Thinking, redacted thinking, image,
 * document and every other block are dropped.
 */
export type ClaudeTranscriptBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool_result'; readonly tool_use_id?: string | undefined };

/**
 * A record's share of the heap beside its content, counted once per row: the object, its identity strings (uuid,
 * parent, session, prompt and request ids, timestamp) and its block array.
 */
const RECORD_OVERHEAD_BYTES = 512;

export interface ClaudeTranscriptRecord {
  /** Stable local identity used only when the provider row has no native id. */
  sourceId: string;
  index: number;
  type?: string | undefined;
  uuid?: string | undefined;
  parentUuid?: string | undefined;
  timestamp: string;
  sessionId?: string | undefined;
  promptId?: string | undefined;
  requestId?: string | undefined;
  agentId?: string | undefined;
  agentType?: string | undefined;
  /**
   * Who opened the turn a `user` row belongs to (2.1.283+). 2.1.308's native values are `human`
   * (typed TUI prompt), `sdk` (print-mode / Agent SDK prompt), `scheduled`, `task_notification`,
   * `auto_continuation`, `peer`, `host_synthetic`, `system` and `unknown`. Claude stamps it on the
   * turn's prompt row, and its auto and prompt-too-long compactions copy the active prompt's
   * value onto the compaction summary. 2.1.226 and earlier transcripts carry none, nor do
   * 2.1.308's slash/local-command, manual `/compact`, interruption and tool-result rows.
   */
  turnOrigin?: string | undefined;
  /** Claude's own marker of a compaction summary, which continues a turn instead of opening one. */
  isCompactSummary?: true | undefined;
  isSidechain: boolean;
  /** The row's message content, slimmed at decode ({@link ClaudeTranscriptBlock}); absent when nothing is kept. */
  content?: readonly ClaudeTranscriptBlock[] | undefined;
  /**
   * An estimate of what this record holds, computed once at decode: its text, its tool inputs as JSON, and a fixed
   * per-row overhead. The reader bounds its window by it, so a payload never kept is never counted.
   */
  keptBytes: number;
}

export function transcriptObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function transcriptString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function timestamp(value: unknown): string {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return new Date(0).toISOString();
}

/** A message's content, slimmed to {@link ClaudeTranscriptBlock}s; string content is one text block. */
function transcriptBlocks(message: Record<string, unknown> | undefined): ClaudeTranscriptBlock[] {
  const content = message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: ClaudeTranscriptBlock[] = [];
  for (const value of content) {
    const block = transcriptObject(value);
    if (block?.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
    } else if (block?.type === 'tool_use') {
      const id = transcriptString(block.id);
      const name = transcriptString(block.name);
      if (id && name) blocks.push({ type: 'tool_use', id, name, input: block.input });
    } else if (block?.type === 'tool_result') {
      const id = transcriptString(block.tool_use_id);
      blocks.push(id ? { type: 'tool_result', tool_use_id: id } : { type: 'tool_result' });
    }
  }
  return blocks;
}

function estimateKeptBytes(content: readonly ClaudeTranscriptBlock[]): number {
  let bytes = RECORD_OVERHEAD_BYTES;
  for (const block of content) {
    if (block.type === 'text') bytes += block.text.length;
    else if (block.type === 'tool_use') bytes += block.id.length + block.name.length + jsonLength(block.input);
    else bytes += block.tool_use_id?.length ?? 0;
  }
  return bytes;
}

/** A decoded JSON value's length re-serialized; `undefined` (an absent input) has none. */
function jsonLength(value: unknown): number {
  return value === undefined ? 0 : JSON.stringify(value).length;
}

/** A malformed or crash-truncated line is skipped; the next poll can recover it once completed. */
export function decodeClaudeTranscript(text: string, startIndex = 0, sourceId = 'root'): ClaudeTranscriptRecord[] {
  const rows: ClaudeTranscriptRecord[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const body = transcriptObject(parsed);
    if (!body) continue;
    const content = transcriptBlocks(transcriptObject(body.message));
    rows.push({
      sourceId,
      index: startIndex + index,
      ...(transcriptString(body.type) ? { type: transcriptString(body.type) } : {}),
      ...(transcriptString(body.uuid) ? { uuid: transcriptString(body.uuid) } : {}),
      ...(transcriptString(body.parentUuid) ? { parentUuid: transcriptString(body.parentUuid) } : {}),
      timestamp: timestamp(body.timestamp),
      ...(transcriptString(body.sessionId ?? body.session_id)
        ? { sessionId: transcriptString(body.sessionId ?? body.session_id) }
        : {}),
      ...(transcriptString(body.promptId ?? body.prompt_id)
        ? { promptId: transcriptString(body.promptId ?? body.prompt_id) }
        : {}),
      ...(transcriptString(body.requestId ?? body.request_id)
        ? { requestId: transcriptString(body.requestId ?? body.request_id) }
        : {}),
      ...(transcriptString(body.agentId ?? body.agent_id)
        ? { agentId: transcriptString(body.agentId ?? body.agent_id) }
        : {}),
      ...(transcriptString(body.agentType ?? body.agent_type)
        ? { agentType: transcriptString(body.agentType ?? body.agent_type) }
        : {}),
      ...(transcriptString(body.turnOrigin) ? { turnOrigin: transcriptString(body.turnOrigin) } : {}),
      ...(body.isCompactSummary === true ? { isCompactSummary: true as const } : {}),
      isSidechain: body.isSidechain === true,
      ...(content.length > 0 ? { content } : {}),
      keptBytes: estimateKeptBytes(content),
    });
  }
  return rows;
}

/**
 * Whether a row can matter to the conversation projection: a message (`type` user or assistant)
 * or a node of the parent-linked graph a message may descend from (it has a `uuid`). Everything
 * else is bookkeeping. Since 2.1.300 Claude records each API request in the session JSONL
 * (`api-request`, `api-request-shape`, `api-request-blob`, `atis-latch`, `cost-state`) beside its
 * side rows; none has a `uuid`, `api-request-blob` echoes a `message.role` (a phantom message to a
 * reader that keys on role), and together they are most of the file.
 */
export function isClaudeTranscriptConversationRow(record: ClaudeTranscriptRecord): boolean {
  return record.type === 'user' || record.type === 'assistant' || record.uuid !== undefined;
}

export function transcriptContent(record: ClaudeTranscriptRecord): readonly ClaudeTranscriptBlock[] {
  return record.content ?? [];
}

export function transcriptText(record: ClaudeTranscriptRecord): string {
  return transcriptContent(record)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('');
}

export function transcriptRecordId(record: ClaudeTranscriptRecord): string {
  return record.uuid ?? record.requestId ?? `${record.sourceId}:line-${record.index}`;
}

export function safeTranscriptEvidence(record: ClaudeTranscriptRecord): Record<string, unknown> {
  return {
    type: record.type,
    uuid: record.uuid,
    parentUuid: record.parentUuid,
    requestId: record.requestId,
    sessionId: record.sessionId,
    promptId: record.promptId,
    agentId: record.agentId,
    agentType: record.agentType,
    timestamp: record.timestamp,
  };
}
