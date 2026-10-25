/**
 * Synthetic Claude Code 2.1.308 session transcripts (unpublished test support). The row kinds,
 * their key sets, and their order follow the sanitized census projection
 * `packages/surface/vendors/claude/captures/claude@2.1.308/transcript-shape.json` and the TUI lane's
 * row sequence; every value is synthetic. Since 2.1.300 Claude interleaves per-request bookkeeping
 * rows (`api-request`, `api-request-shape`, `api-request-blob`, `atis-latch`, `cost-state`) with the
 * conversation, and `api-request-blob` carries a `message.role` with neither `uuid` nor timestamp.
 */

export const CLAUDE_2_1_308_BOOKKEEPING_TYPES = [
  'api-request',
  'api-request-shape',
  'api-request-blob',
  'atis-latch',
  'cost-state',
] as const;

/** Side rows written beside each turn; like the bookkeeping rows they carry no `uuid`. */
export const CLAUDE_2_1_308_SIDE_TYPES = [
  'agent-name',
  'custom-title',
  'file-history-delta',
  'file-history-snapshot',
  'last-prompt',
  'mode',
  'permission-mode',
  'queue-operation',
] as const;

/** 2.1.308's `turnOrigin` enum, as compiled into the binary. */
export type Claude2308TurnOrigin =
  | 'human'
  | 'sdk'
  | 'scheduled'
  | 'task_notification'
  | 'auto_continuation'
  | 'peer'
  | 'host_synthetic'
  | 'system'
  | 'unknown';

export interface Claude2308Turn {
  /** The `uuid` of the turn's typed prompt row. */
  promptUuid: string;
  prompt: string;
  /** Final assistant text. */
  answer: string;
  /** The prompt row's native origin: `human` (the default) for a typed prompt. */
  turnOrigin?: Claude2308TurnOrigin;
  /** Run one Bash tool round trip before the answer, as the lane's tool turns do. */
  tool?: boolean;
}

export interface Claude2308TranscriptOptions {
  sessionId?: string;
  /** Start of the synthetic clock. */
  startedAt?: string;
}

/**
 * Rows of one 2.1.308-shaped session, in physical order. Each turn: side rows, the prompt, an
 * attachment, request bookkeeping (a user-role `api-request-blob` echoing the prompt), optionally a
 * tool round trip with its own bookkeeping, the answer, stop and duration system rows, and cost
 * state. The first turn's request also replays one assistant-role blob, as the lane's did once.
 */
export function claude2308TranscriptRows(
  turns: readonly Claude2308Turn[],
  options: Claude2308TranscriptOptions = {},
): Record<string, unknown>[] {
  const sessionId = options.sessionId ?? '00000000-0000-4000-8000-000000000308';
  let clock = Date.parse(options.startedAt ?? '2026-10-25T02:00:00.000Z');
  const at = () => new Date((clock += 250)).toISOString();
  const base = { sessionId, cwd: '/workspace', version: '2.1.308', gitBranch: 'main', userType: 'external' };
  const rows: Record<string, unknown>[] = [];
  let parent: string | null = null;
  let request = 0;

  const sideRows = (title: string) => {
    rows.push(
      { type: 'custom-title', customTitle: title, sessionId },
      { type: 'agent-name', agentName: 'synthetic', sessionId },
      { type: 'mode', mode: 'normal', sessionId },
      { type: 'permission-mode', permissionMode: 'default', sessionId },
      { type: 'atis-latch', latch: {}, sessionId },
      { type: 'file-history-snapshot', messageId: `snapshot-${rows.length}`, snapshot: {}, isSnapshotUpdate: false },
    );
  };
  const node = (row: Record<string, unknown>) => {
    rows.push({ ...base, parentUuid: parent, isSidechain: false, timestamp: at(), ...row });
    parent = row.uuid as string;
  };
  const bookkeeping = (blobs: Array<{ role: 'user' | 'assistant'; content: unknown }>) => {
    request += 1;
    for (const message of blobs) rows.push({ type: 'api-request-blob', hash: `blob-${request}`, message, sessionId });
    rows.push({
      type: 'api-request',
      id: `api-${request}`,
      querySource: 'repl_main_thread',
      params: {},
      tail: [],
      cacheControl: {},
      requestDigest: `digest-${request}`,
      base: null,
      keep: 0,
      shapeHash: 'shape-1',
      version: 1,
      sessionId,
      timestamp: at(),
    });
  };

  for (const [index, turn] of turns.entries()) {
    sideRows(`turn ${index + 1}`);
    node({
      type: 'user',
      uuid: turn.promptUuid,
      promptId: `prompt-${turn.promptUuid}`,
      turnOrigin: turn.turnOrigin ?? 'human',
      turnPosition: { promptIndex: index, turnIndex: index },
      message: { role: 'user', content: turn.prompt },
    });
    node({ type: 'attachment', uuid: `${turn.promptUuid}-context`, attachment: { type: 'synthetic' } });
    if (index === 0) {
      rows.push({ type: 'api-request-shape', shape: {}, shapeHash: 'shape-1', version: 1, sessionId, timestamp: at() });
    }
    bookkeeping([
      { role: 'user', content: [{ type: 'text', text: turn.prompt }] },
      ...(index === 0
        ? [{ role: 'assistant' as const, content: [{ type: 'text', text: 'Replayed assistant prefill.' }] }]
        : []),
    ]);
    if (turn.tool) {
      const toolUseId = `toolu-${turn.promptUuid}`;
      node({
        type: 'assistant',
        uuid: `${turn.promptUuid}-tool-call`,
        requestId: `req-${turn.promptUuid}-1`,
        requestRef: `api-${request}`,
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-5-20250929',
          content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'true' } }],
        },
      });
      node({
        type: 'user',
        uuid: `${turn.promptUuid}-tool-result`,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
      });
      bookkeeping([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] }]);
      node({ type: 'attachment', uuid: `${turn.promptUuid}-tool-context`, attachment: { type: 'synthetic' } });
    }
    node({
      type: 'assistant',
      uuid: `${turn.promptUuid}-answer`,
      requestId: `req-${turn.promptUuid}-2`,
      requestRef: `api-${request}`,
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-5-20250929',
        content: [{ type: 'text', text: turn.answer }],
      },
    });
    node({ type: 'system', uuid: `${turn.promptUuid}-stop`, subtype: 'stop_hook_summary' });
    node({ type: 'system', uuid: `${turn.promptUuid}-duration`, subtype: 'turn_duration', isMeta: false });
    rows.push(
      { type: 'last-prompt', lastPrompt: turn.prompt, sessionId },
      { type: 'cost-state', modelUsage: {}, totalCostUSD: 0, sessionId },
    );
  }
  return rows;
}

export function claude2308TranscriptText(
  turns: readonly Claude2308Turn[],
  options: Claude2308TranscriptOptions = {},
): string {
  return claude2308TranscriptRows(turns, options)
    .map((row) => JSON.stringify(row))
    .join('\n')
    .concat('\n');
}
