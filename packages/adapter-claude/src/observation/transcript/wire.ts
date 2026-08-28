/** Minimal, tolerant model of the Claude transcript rows this adapter consumes. */

export interface ClaudeTranscriptRecord {
  /** Stable local identity used only when the provider row has no native id. */
  sourceId: string;
  index: number;
  type?: string;
  uuid?: string;
  parentUuid?: string;
  timestamp: string;
  sessionId?: string;
  promptId?: string;
  requestId?: string;
  agentId?: string;
  agentType?: string;
  isSidechain: boolean;
  message?: Record<string, unknown>;
}

export function transcriptObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function transcriptString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function transcriptNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
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
      isSidechain: body.isSidechain === true,
      ...(transcriptObject(body.message) ? { message: transcriptObject(body.message) } : {}),
    });
  }
  return rows;
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
