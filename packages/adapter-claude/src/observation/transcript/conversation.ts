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
  transcriptRecordId,
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
  if (transcriptContent(record).some((block) => block.type === 'tool_result')) return false;
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

function assistant(record: ClaudeTranscriptRecord, text: string, turnId: string | undefined): SemanticObservationEvent {
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
 * while retaining file order for unrelated rows and malformed cycles; `cyclic`
 * says a cycle's rows were ordered after every other row.
 */
function causalOrder(records: readonly ClaudeTranscriptRecord[]): {
  ordered: ClaudeTranscriptRecord[];
  cyclic: boolean;
} {
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
  let cyclic = false;
  for (const [index, record] of records.entries()) {
    if (emitted[index] !== 0) continue;
    ordered.push(record);
    cyclic = true;
  }
  return { ordered, cyclic };
}

/** The turn the assistant walk is in: the last prompt it passed, or the turn a known reply kept. */
interface AssistantWalk {
  turnId: string | undefined;
}

/** A reply the walk projects, under its key (its record id). */
interface WalkedReply {
  readonly key: string;
  readonly text: string;
  readonly projected: SemanticObservationEvent;
}

/** A key's last walked reply, and how many rows of the walk carry the key. */
interface CountedReply extends WalkedReply {
  readonly rows: number;
}

/** Records a walked reply under its key: the key's last row wins, as in a full walk, and every row is counted. */
function collect(replies: Map<string, CountedReply>, reply: WalkedReply | undefined): void {
  if (reply) replies.set(reply.key, { ...reply, rows: (replies.get(reply.key)?.rows ?? 0) + 1 });
}

/** The reply a row is, when it is one: a root (non-sidechain) assistant row with text. */
function projectedReply(record: ClaudeTranscriptRecord): { key: string; text: string } | undefined {
  // The row type decides: 2.1.308's `api-request-blob` bookkeeping rows echo a user or assistant
  // message and are neither a prompt nor a reply.
  if (record.isSidechain || record.type !== 'assistant') return undefined;
  const text = transcriptText(record);
  return text ? { key: transcriptRecordId(record), text } : undefined;
}

/**
 * One row of the assistant walk. A message's turn changes only when a row arrives, never when one leaves the window:
 * the window's lower edge is no evidence. So a reply an earlier read projected keeps the turn it had when the walk has
 * no turn open at it (its prompt is outside the window), or when its parent has left the window (`cut`: the window held
 * the parent and evicted it, so the row's causal position is no evidence either), and the walk continues in that turn,
 * so the row's own descendants follow it. A parent that has not arrived yet cuts nothing: it is no departure, and the
 * turn a reply kept under it would carry on to rows that never descended from it. Otherwise the walk's turn wins: a
 * reply flushed before its prompt (teardown) moves to the prompt's turn when the prompt arrives, which is why a turn
 * can change at all.
 */
function stepAssistantWalk(
  walk: AssistantWalk,
  record: ClaudeTranscriptRecord,
  cut: boolean,
  known: (key: string) => { readonly turnId: string | undefined } | undefined,
): WalkedReply | undefined {
  if (record.isSidechain) return undefined;
  if (record.type === 'user') {
    if (opensUserTurn(record)) walk.turnId = transcriptRecordId(record);
    return undefined;
  }
  const reply = projectedReply(record);
  if (!reply) return undefined;
  const kept = known(reply.key);
  if (kept && (walk.turnId === undefined || cut)) walk.turnId = kept.turnId;
  return { ...reply, projected: assistant(record, reply.text, walk.turnId) };
}

/**
 * Extract root assistant messages for live observation without synthesizing historical turns. `knownTurns` holds the
 * turn an earlier read gave each message key, and `departed` the uuids an earlier read's window held and has since
 * evicted ({@link stepAssistantWalk}), so a window that has dropped rows re-keys no message it still holds.
 */
export function projectClaudeTranscriptAssistants(
  records: readonly ClaudeTranscriptRecord[],
  options: {
    knownTurns?: ReadonlyMap<string, string | undefined> | undefined;
    departed?: ReadonlySet<string> | undefined;
  } = {},
): ReadonlyMap<string, SemanticObservationEvent> {
  const { knownTurns, departed } = options;
  const uuids = new Set<string>();
  for (const record of records) if (record.uuid !== undefined) uuids.add(record.uuid);
  const walk = walkAssistants(
    records,
    (uuid) => !uuids.has(uuid) && departed?.has(uuid) === true,
    (key) => (knownTurns?.has(key) ? { turnId: knownTurns.get(key) } : undefined),
  );
  const assistants = new Map<string, SemanticObservationEvent>();
  for (const [key, { projected }] of walk.replies) assistants.set(key, projected);
  return assistants;
}

/**
 * The full walk: every row of the window in causal order, and the turn and the cycle flag it ends with. `departed` says
 * whether a parent uuid has left the window ({@link stepAssistantWalk}).
 */
function walkAssistants(
  records: readonly ClaudeTranscriptRecord[],
  departed: (uuid: string) => boolean,
  known: (key: string) => { readonly turnId: string | undefined } | undefined,
): { replies: Map<string, CountedReply>; turnId: string | undefined; cyclic: boolean } {
  const { ordered, cyclic } = causalOrder(records);
  const replies = new Map<string, CountedReply>();
  const walk: AssistantWalk = { turnId: undefined };
  for (const record of ordered) {
    const cut = record.parentUuid !== undefined && departed(record.parentUuid);
    collect(replies, stepAssistantWalk(walk, record, cut, known));
  }
  return { replies, turnId: walk.turnId, cyclic };
}

/** What changed between two reads of one transcript reader: the rows evicted at its head and appended at its tail. */
export interface ClaudeTranscriptDelta {
  readonly evicted: readonly ClaudeTranscriptRecord[];
  readonly appended: readonly ClaudeTranscriptRecord[];
}

/** A message the projection holds: its turn and text (the only fields that vary), and the window rows keyed to it. */
interface KnownReply {
  readonly turnId: string | undefined;
  readonly text: string;
  readonly rows: number;
}

/** Moves a key's count by one, forgetting the key at zero. */
function count(counts: Map<string, number>, key: string, by: 1 | -1): void {
  const next = (counts.get(key) ?? 0) + by;
  if (next > 0) counts.set(key, next);
  else counts.delete(key);
}

/**
 * The assistant projection of one session's transcript window, kept between reads. The reader only appends at its tail
 * and evicts at its head, so a read extends the walk by the rows it appended instead of walking the window again: an
 * appended row whose parent is absent or already present is causally last (min-index order pops it only when nothing
 * else is ready, and it has no children), so the walk continues from its end. A departure never re-keys a message
 * ({@link stepAssistantWalk}), so an eviction only forgets, and remembers which parents have left.
 *
 * The full walk ({@link ClaudeTranscriptProjection.reproject}) runs at the first read, on a read that is not a pure
 * append and evict, when an appended row is the parent of a row the window holds without its parent (a parent flushed
 * after its child re-orders the walk), and while the last full walk left a cycle, whose rows it orders after every
 * other row, so no appended row is last.
 */
export class ClaudeTranscriptProjection {
  /** The turn the walk is in at its causal end. */
  private turnId: string | undefined;
  /** How many rows of the session window carry each uuid. */
  private readonly uuids = new Map<string, number>();
  /** How many rows of the session window name each uuid as their parent. */
  private readonly parents = new Map<string, number>();
  /** Rows the window holds without their parent, by the parent's uuid: its arrival re-orders them. */
  private readonly orphans = new Map<string, Set<ClaudeTranscriptRecord>>();
  /**
   * The parents that have left the window: uuids it held and evicted while a row it still holds names them. Those rows'
   * ancestry was cut by the window, never by the transcript ({@link stepAssistantWalk}); a parent that has not arrived
   * yet is never here. A uuid is forgotten once no window row names it, so the set is bounded by the window.
   */
  private readonly departed = new Set<string>();
  /** The last full walk left a cycle remainder. */
  private hasCycle = false;
  private readonly replies = new Map<string, KnownReply>();

  constructor(private readonly nativeSessionId: string) {}

  /** The rows of this session: a row that does not repeat its session id belongs to it. */
  sessionRows(records: readonly ClaudeTranscriptRecord[]): ClaudeTranscriptRecord[] {
    return records.filter((record) => this.inSession(record));
  }

  /**
   * Takes one read of the window and returns the messages whose turn or text it changed. `delta` is what changed since
   * the previous read; without one the window is walked whole.
   */
  apply(
    records: readonly ClaudeTranscriptRecord[],
    delta: ClaudeTranscriptDelta | undefined,
  ): SemanticObservationEvent[] {
    if (delta === undefined) return this.reproject(records);
    for (const record of delta.evicted) this.evict(record);
    if (!this.extendsWalk(delta.appended)) return this.reproject(records);
    const walk: AssistantWalk = { turnId: this.turnId };
    const walked = new Map<string, CountedReply>();
    for (const record of delta.appended) {
      if (!this.inSession(record)) continue;
      this.hold(record);
      const absent = this.absentParent(record);
      if (absent !== undefined) this.orphan(absent, record);
      collect(walked, stepAssistantWalk(walk, record, this.cut(record), (key) => this.replies.get(key)));
    }
    this.turnId = walk.turnId;
    return this.settle(walked, true);
  }

  /** The full walk of the session window, under the departure rule; it rebuilds the incremental state. */
  reproject(records: readonly ClaudeTranscriptRecord[]): SemanticObservationEvent[] {
    const session = this.sessionRows(records);
    const held = [...this.uuids.keys()];
    this.uuids.clear();
    this.parents.clear();
    this.orphans.clear();
    for (const record of session) this.hold(record);
    // A departure is history the window cannot show: the previous window's uuids this one lost join it while a row
    // names them, and a departed uuid the window holds again, or that no row names any more, leaves it.
    for (const uuid of held) if (!this.uuids.has(uuid) && this.parents.has(uuid)) this.departed.add(uuid);
    for (const uuid of this.departed) if (this.uuids.has(uuid) || !this.parents.has(uuid)) this.departed.delete(uuid);
    for (const record of session) {
      const absent = this.absentParent(record);
      if (absent !== undefined) this.orphan(absent, record);
    }
    const walk = walkAssistants(session, (uuid) => this.departed.has(uuid), (key) => this.replies.get(key));
    this.turnId = walk.turnId;
    this.hasCycle = walk.cyclic;
    const changed = this.settle(walk.replies, false);
    for (const key of this.replies.keys()) if (!walk.replies.has(key)) this.replies.delete(key);
    return changed;
  }

  private inSession(record: ClaudeTranscriptRecord): boolean {
    return !record.sessionId || record.sessionId === this.nativeSessionId;
  }

  /** Counts a row the window now holds: its uuid, and its parent's. */
  private hold(record: ClaudeTranscriptRecord): void {
    if (record.uuid !== undefined) count(this.uuids, record.uuid, 1);
    if (record.parentUuid !== undefined) count(this.parents, record.parentUuid, 1);
  }

  /** The uuid of a row's parent when the window lacks it: not arrived yet, or departed. */
  private absentParent(record: ClaudeTranscriptRecord): string | undefined {
    const parent = record.parentUuid;
    return parent !== undefined && !this.uuids.has(parent) ? parent : undefined;
  }

  /** Whether a row's parent has left the window, so the window has cut the row's ancestry. */
  private cut(record: ClaudeTranscriptRecord): boolean {
    return record.parentUuid !== undefined && this.departed.has(record.parentUuid);
  }

  private orphan(parent: string, record: ClaudeTranscriptRecord): void {
    const waiting = this.orphans.get(parent);
    if (waiting) waiting.add(record);
    else this.orphans.set(parent, new Set([record]));
  }

  /**
   * Whether the appended rows extend the walk, each causally last: none is the parent of a row the window holds
   * without its parent (one that has not arrived, or a departed parent back), or of an earlier row of the same append,
   * and the last full walk left no cycle.
   */
  private extendsWalk(appended: readonly ClaudeTranscriptRecord[]): boolean {
    if (this.hasCycle) return false;
    const arriving = new Set<string>();
    const awaited = new Set<string>();
    for (const record of appended) {
      if (!this.inSession(record)) continue;
      if (record.uuid !== undefined) {
        const parentOfHeld = this.orphans.has(record.uuid) || this.departed.has(record.uuid);
        if (parentOfHeld || awaited.has(record.uuid)) return false;
        arriving.add(record.uuid);
      }
      const parent = record.parentUuid;
      if (parent !== undefined && !this.uuids.has(parent) && !arriving.has(parent)) awaited.add(parent);
    }
    return true;
  }

  /**
   * Forgets an evicted row: its uuid, its count as a child, its wait for an absent parent, and its message once no
   * window row carries it. A uuid that leaves while a row the window holds names it has departed; a departed uuid no
   * row names any more is forgotten.
   */
  private evict(record: ClaudeTranscriptRecord): void {
    if (!this.inSession(record)) return;
    if (record.uuid !== undefined) {
      count(this.uuids, record.uuid, -1);
      if (!this.uuids.has(record.uuid) && this.parents.has(record.uuid)) this.departed.add(record.uuid);
    }
    const parent = record.parentUuid;
    if (parent !== undefined) {
      count(this.parents, parent, -1);
      if (!this.parents.has(parent)) this.departed.delete(parent);
      const waiting = this.orphans.get(parent);
      if (waiting?.delete(record) && waiting.size === 0) this.orphans.delete(parent);
    }
    const reply = projectedReply(record);
    const known = reply === undefined ? undefined : this.replies.get(reply.key);
    if (reply === undefined || known === undefined) return;
    if (known.rows > 1) this.replies.set(reply.key, { ...known, rows: known.rows - 1 });
    else this.replies.delete(reply.key);
  }

  /**
   * Records the walked messages and returns those whose turn or text changed. An extending walk adds its rows to a
   * key's count; a full walk counts every row the window holds.
   */
  private settle(walked: ReadonlyMap<string, CountedReply>, extending: boolean): SemanticObservationEvent[] {
    const changed: SemanticObservationEvent[] = [];
    for (const [key, reply] of walked) {
      const known = this.replies.get(key);
      const { turnId } = reply.projected;
      if (known === undefined || known.turnId !== turnId || known.text !== reply.text) changed.push(reply.projected);
      const rows = extending && known !== undefined ? known.rows + reply.rows : reply.rows;
      this.replies.set(key, { turnId, text: reply.text, rows });
    }
    return changed;
  }
}

/** The tool calls a `user` row answers: the ids its `tool_result` blocks name. */
function answeredToolIds(record: ClaudeTranscriptRecord): string[] {
  return transcriptContent(record).flatMap((block) =>
    block.type === 'tool_result' && block.tool_use_id !== undefined ? [block.tool_use_id] : [],
  );
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
  for (const record of causalOrder(records).ordered) {
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
    for (const block of transcriptContent(record)) {
      if (block.type === 'tool_use') tools.set(block.id, { record, name: block.name, input: block.input });
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
