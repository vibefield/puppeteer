/** Minimal, tolerant model of the Claude transcript rows this adapter consumes. */

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
  message?: Record<string, unknown> | undefined;
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
      ...(transcriptObject(body.message) ? { message: transcriptObject(body.message) } : {}),
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

export function transcriptContent(record: ClaudeTranscriptRecord): unknown[] {
  const content = record.message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

export function transcriptText(record: ClaudeTranscriptRecord): string {
  return transcriptContent(record)
    .flatMap((value) => {
      const block = transcriptObject(value);
      return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
    })
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
