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

/** What causal order reads of a row: its uuid and its parent's. */
interface CausalRow {
  readonly uuid?: string | undefined;
  readonly parentUuid?: string | undefined;
}

/**
 * Claude's transcript is a parent-linked graph. Its append workers can flush
 * rows out of physical order during process teardown, so line order alone is
 * not a trustworthy conversation order. Walk each row's known ancestry first
 * while retaining file order for unrelated rows and malformed cycles; `cyclic`
 * says a cycle's rows were ordered after every other row. A uuid written more
 * than once adopts children at its first row only, and a uuid `passed` names
 * was walked before these rows, so a row naming it is ready at once.
 */
function causalOrder<Row extends CausalRow>(
  records: readonly Row[],
  passed: (uuid: string) => boolean = () => false,
): { ordered: Row[]; cyclic: boolean } {
  const firstIndexByUuid = new Map<string, number>();
  for (const [index, record] of records.entries()) {
    if (record.uuid !== undefined && !firstIndexByUuid.has(record.uuid)) firstIndexByUuid.set(record.uuid, index);
  }
  const children = Array.from({ length: records.length }, () => [] as number[]);
  const indegree = new Uint8Array(records.length);
  for (const [index, record] of records.entries()) {
    const parent = record.parentUuid;
    const parentIndex = parent === undefined || passed(parent) ? undefined : firstIndexByUuid.get(parent);
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
  const ordered: Row[] = [];
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

/**
 * A row as the assistant walk reads it. A row that has left the window keeps only what the walk needs to pass it at its
 * causal place: its ids, its file order, whether it opens a turn and what its last pass gave; never its text.
 */
interface WalkRow {
  readonly uuid: string | undefined;
  readonly parentUuid: string | undefined;
  /** Its place in file order among the rows the walk has held. */
  readonly serial: number;
  /** The turn it opens when it is a person's prompt: its record id. */
  readonly id: string;
  readonly opens: boolean;
  /** Its record while the window holds it; a departed row keeps none. */
  record: ClaudeTranscriptRecord | undefined;
  /** The appended-row count at which it left the window; undefined while the window holds it. */
  departedAt: number | undefined;
  /** Whether its last pass was its uuid's first. */
  first: boolean;
  /** The running turn after its last pass. */
  after: string | undefined;
}

function walkRow(record: ClaudeTranscriptRecord, serial: number): WalkRow {
  return {
    uuid: record.uuid,
    parentUuid: record.parentUuid,
    serial,
    id: transcriptRecordId(record),
    opens: !record.isSidechain && record.type === 'user' && opensUserTurn(record),
    record,
    departedAt: undefined,
    first: true,
    after: undefined,
  };
}

/** The assistant walk's state: the running turn (the last prompt passed), and the turn each uuid's first pass took. */
interface AssistantWalk {
  turnId: string | undefined;
  readonly turns: Map<string, string | undefined>;
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
 * One row of the assistant walk, the one rule the full walk and the projection's extending walk share. A person's
 * prompt opens its turn, and every other row is in the running turn: the last prompt passed. A uuid the walk has passed
 * moves nothing when it is passed again: it opens no turn, adopts no children ({@link causalOrder} links them to its
 * first row) and keeps its first pass's turn, while a reply written again still gives its key its text. So a row's
 * turn depends only on the rows before it in causal order, never on which of them the window still holds.
 */
function stepAssistantWalk(walk: AssistantWalk, row: WalkRow): WalkedReply | undefined {
  row.first = row.uuid === undefined || !walk.turns.has(row.uuid);
  if (row.first && row.opens) walk.turnId = row.id;
  const turnId = row.first || row.uuid === undefined ? walk.turnId : walk.turns.get(row.uuid);
  if (row.first && row.uuid !== undefined) walk.turns.set(row.uuid, turnId);
  row.after = walk.turnId;
  const { record } = row;
  const reply = record === undefined ? undefined : projectedReply(record);
  if (record === undefined || reply === undefined) return undefined;
  return { ...reply, projected: assistant(record, reply.text, turnId) };
}

/**
 * The full walk of `rows` (given in file order) in causal order, from the walk's running turn. A uuid already in the
 * walk's turns was passed before these rows: a row naming it is ready at once, and a row carrying it moves nothing.
 */
function walkAssistants(
  rows: readonly WalkRow[],
  walk: AssistantWalk,
): { ordered: WalkRow[]; replies: Map<string, CountedReply>; cyclic: boolean } {
  const { ordered, cyclic } = causalOrder(rows, (uuid) => walk.turns.has(uuid));
  const replies = new Map<string, CountedReply>();
  for (const row of ordered) collect(replies, stepAssistantWalk(walk, row));
  return { ordered, replies, cyclic };
}

/**
 * Extract root assistant messages for live observation without synthesizing historical turns: every row given, walked
 * in causal order from no turn ({@link stepAssistantWalk}). Over a whole transcript this is the unbounded walk, whose
 * turns {@link ClaudeTranscriptProjection} gives every row its window holds. A uuid written again keeps its first row's
 * turn and children, and gives its message its last row's text.
 */
export function projectClaudeTranscriptAssistants(
  records: readonly ClaudeTranscriptRecord[],
): ReadonlyMap<string, SemanticObservationEvent> {
  const rows = records.map((record, serial) => walkRow(record, serial));
  const { replies } = walkAssistants(rows, { turnId: undefined, turns: new Map() });
  const assistants = new Map<string, SemanticObservationEvent>();
  for (const [key, { projected }] of replies) assistants.set(key, projected);
  return assistants;
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
 * The assistant projection of one session's transcript window, kept between reads. For every row the window holds, a
 * message's turn is the one the unbounded walk gives it ({@link projectClaudeTranscriptAssistants} over every row the
 * session has written), whichever rows the window still holds. The walk replays the unbounded walk's order with what
 * the window has lost:
 * - The seed. The walk starts in the running turn the unbounded walk is in after the departed rows it passes before
 *   every row the walk still holds or keeps: the last prompt passed among them in walk order, not in eviction order.
 * - The departed skeleton. A departed row the unbounded walk may still pass after a held row or a row still to come
 *   (it waits on a parent the window holds, or one that has not arrived, or follows such a row) keeps its ids, its file
 *   order and whether it opens a turn, never its text, and is walked at its causal place. Once it is first in walk
 *   order and nothing can re-place it (its parent has been passed, or it has none), it joins the seed.
 * - A uuid written again moves nothing ({@link stepAssistantWalk}), so a row written again whose first row has left
 *   the window adopts none of that row's children and takes its turn.
 * So a departure re-keys no message: an eviction moves rows into the skeleton or the seed and walks nothing.
 *
 * The reader only appends at its tail and evicts at its head, so a read extends the walk by the rows it appended
 * instead of walking again: an appended row whose parent the walk has passed, or has not seen, is causally last
 * (min-index order pops it only when nothing else is ready, and it has no children), so the walk continues from its
 * end. The full walk ({@link ClaudeTranscriptProjection.reproject}) runs at a read with no delta, when an appended row
 * is the parent of a row the walk holds or keeps without its parent (a parent flushed after its child re-orders the
 * walk), and while the last full walk left a cycle, whose rows it orders after every other row, so no appended row is
 * last.
 *
 * Stated limits, each counted in appended rows against the window's own length (`patience`, the rows a read holds):
 * - a departed row waiting on a parent that has not arrived joins the seed once `patience` rows have been appended
 *   since it left, so a parent later than that is walked as a new row and re-places nothing;
 * - the seed remembers a uuid it passed for `patience` appended rows after the last row carrying it joined, so a row
 *   written again later than that is walked as a first row: a prompt opens its turn again, and rows naming the uuid
 *   hang from it;
 * - a read with no delta whose window shares no row (by uuid) with the previous window starts unseeded.
 * The skeleton and the uuids the seed remembers hold ids only, never text, and stay bounded by the window: a departed
 * row stays walked only while a row before it in walk order is held or waits, and a wait ends within `patience`.
 */
export class ClaudeTranscriptProjection {
  /** The running turn after the rows that joined the seed: the departed rows walked before every row still walked. */
  private seed: string | undefined;
  /** The rows still walked, in walk order from `head`: the window's session rows and the departed skeleton. */
  private walked: WalkRow[] = [];
  private head = 0;
  /** The window's session rows, in file order, and their walk rows. */
  private readonly held = new Map<ClaudeTranscriptRecord, WalkRow>();
  /** The turn each uuid's first pass took: every walked row's, and the seed's while it remembers them. */
  private readonly turns = new Map<string, string | undefined>();
  /** The uuids the seed remembers, by the appended-row count at which their last row joined it, oldest first. */
  private readonly seeded = new Map<string, number>();
  /** How many walked rows carry each uuid. */
  private readonly uuids = new Map<string, number>();
  /** Walked rows whose parent the walk has neither passed nor holds, by the parent's uuid: it re-orders them. */
  private readonly orphans = new Map<string, Set<WalkRow>>();
  /** The turn the walk is in at its causal end. */
  private turnId: string | undefined;
  /** The last full walk left a cycle remainder. */
  private hasCycle = false;
  /** Rows appended since the first read: the clock a departed row's patience runs on. */
  private appendedRows = 0;
  /** Walk rows made so far: the next one's place in file order. */
  private serials = 0;
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
    if (delta === undefined) return this.restart(records);
    this.appendedRows += delta.appended.length;
    for (const record of delta.evicted) this.depart(record);
    this.joinSeed(records.length);
    if (!this.extendsWalk(delta.appended)) return this.reproject(records);
    const walk: AssistantWalk = { turnId: this.turnId, turns: this.turns };
    const walked = new Map<string, CountedReply>();
    for (const record of delta.appended) {
      if (!this.inSession(record)) continue;
      const row = this.hold(record);
      this.walked.push(row);
      collect(walked, stepAssistantWalk(walk, row));
    }
    this.turnId = walk.turnId;
    return this.settle(walked, true);
  }

  /**
   * The full walk: the departed skeleton in file order, then the window's session rows, walked in causal order from the
   * seed. It walks every row it still walks anew; the uuids the seed remembers stay passed.
   */
  reproject(records: readonly ClaudeTranscriptRecord[]): SemanticObservationEvent[] {
    const walked = this.walked.slice(this.head);
    for (const row of walked) if (row.first && row.uuid !== undefined) this.turns.delete(row.uuid);
    const skeleton = walked.filter((row) => row.departedAt !== undefined).sort((a, b) => a.serial - b.serial);
    const rows = [...skeleton, ...this.sessionRows(records).map((record) => this.rowOf(record))];
    this.held.clear();
    this.uuids.clear();
    this.orphans.clear();
    for (const row of rows) {
      if (row.record !== undefined) this.held.set(row.record, row);
      if (row.uuid !== undefined) count(this.uuids, row.uuid, 1);
    }
    for (const row of rows) this.orphanIfAbsent(row);
    const walk: AssistantWalk = { turnId: this.seed, turns: this.turns };
    const { ordered, replies, cyclic } = walkAssistants(rows, walk);
    this.walked = ordered;
    this.head = 0;
    this.turnId = walk.turnId;
    this.hasCycle = cyclic;
    const changed = this.settle(replies, false);
    for (const key of this.replies.keys()) if (!replies.has(key)) this.replies.delete(key);
    return changed;
  }

  /**
   * A read with no delta: the first read, or a reader that read the file again (new record objects). The rows the old
   * window held that the new one lacks (by uuid, a uuid's earliest rows first) leave first, in file order, so the walk
   * keeps what they gave; a window that shares no row with the old one starts unseeded.
   */
  private restart(records: readonly ClaudeTranscriptRecord[]): SemanticObservationEvent[] {
    const carried = new Map<string, number>();
    for (const record of this.sessionRows(records)) if (record.uuid !== undefined) count(carried, record.uuid, 1);
    const old = [...this.held.keys()];
    if (old.some(({ uuid }) => uuid !== undefined && carried.has(uuid))) {
      const unmatched = new Map<string, number>();
      for (const { uuid } of old) if (uuid !== undefined) count(unmatched, uuid, 1);
      for (const record of old) {
        const { uuid } = record;
        if (uuid !== undefined && (unmatched.get(uuid) ?? 0) <= (carried.get(uuid) ?? 0)) continue;
        if (uuid !== undefined) count(unmatched, uuid, -1);
        this.depart(record);
      }
    } else {
      this.seed = undefined;
      this.walked = [];
      this.head = 0;
      this.turns.clear();
      this.seeded.clear();
    }
    this.joinSeed(records.length);
    return this.reproject(records);
  }

  private inSession(record: ClaudeTranscriptRecord): boolean {
    return !record.sessionId || record.sessionId === this.nativeSessionId;
  }

  /** A walk row for a record the window now holds, next in file order. */
  private rowOf(record: ClaudeTranscriptRecord): WalkRow {
    this.serials += 1;
    return walkRow(record, this.serials);
  }

  /** A row the window now holds, walked next: counted by its uuid, and waiting on its parent when the walk lacks it. */
  private hold(record: ClaudeTranscriptRecord): WalkRow {
    const row = this.rowOf(record);
    this.held.set(record, row);
    if (row.uuid !== undefined) count(this.uuids, row.uuid, 1);
    this.orphanIfAbsent(row);
    return row;
  }

  /** Whether the walk has passed a uuid, or holds or keeps a row carrying it. */
  private present(uuid: string): boolean {
    return this.uuids.has(uuid) || this.turns.has(uuid);
  }

  /** Records a walked row whose parent the walk has neither passed nor holds: the parent's arrival re-orders it. */
  private orphanIfAbsent(row: WalkRow): void {
    const parent = row.parentUuid;
    if (parent === undefined || this.present(parent)) return;
    const waiting = this.orphans.get(parent);
    if (waiting) waiting.add(row);
    else this.orphans.set(parent, new Set([row]));
  }

  private unorphan(parent: string, row: WalkRow): void {
    const waiting = this.orphans.get(parent);
    if (waiting?.delete(row) && waiting.size === 0) this.orphans.delete(parent);
  }

  /**
   * Whether the appended rows extend the walk, each causally last: none is the parent of a row the walk holds or keeps
   * without its parent, or of an earlier row of the same append, and the last full walk left no cycle. A uuid the walk
   * has passed, written again, re-places nothing: its children stay with its first row.
   */
  private extendsWalk(appended: readonly ClaudeTranscriptRecord[]): boolean {
    if (this.hasCycle) return false;
    const arriving = new Set<string>();
    const awaited = new Set<string>();
    for (const record of appended) {
      if (!this.inSession(record)) continue;
      if (record.uuid !== undefined) {
        if (this.orphans.has(record.uuid) || awaited.has(record.uuid)) return false;
        arriving.add(record.uuid);
      }
      const parent = record.parentUuid;
      if (parent !== undefined && !this.present(parent) && !arriving.has(parent)) awaited.add(parent);
    }
    return true;
  }

  /**
   * A row the window evicted stays walked as the skeleton's, its ids only, until it joins the seed; its message counts
   * one row fewer, and is forgotten once no window row carries its key.
   */
  private depart(record: ClaudeTranscriptRecord): void {
    const row = this.held.get(record);
    if (row === undefined) return;
    this.held.delete(record);
    row.record = undefined;
    row.departedAt = this.appendedRows;
    const reply = projectedReply(record);
    const known = reply === undefined ? undefined : this.replies.get(reply.key);
    if (reply === undefined || known === undefined) return;
    if (known.rows > 1) this.replies.set(reply.key, { ...known, rows: known.rows - 1 });
    else this.replies.delete(reply.key);
  }

  /**
   * Moves the walk's departed head into the seed while nothing can re-place it: a departed row first in walk order
   * whose parent the walk has passed (or that has none), or that has waited `patience` appended rows since it left for
   * a parent that has not arrived. Then forgets the uuids the seed has remembered for `patience` appended rows, unless
   * a walked row still carries one.
   */
  private joinSeed(patience: number): void {
    while (this.head < this.walked.length) {
      const row = this.walked[this.head]!;
      if (row.departedAt === undefined) break;
      const waits = row.parentUuid !== undefined && !this.turns.has(row.parentUuid);
      if (waits && this.appendedRows - row.departedAt < patience) break;
      this.head += 1;
      this.seed = row.after;
      if (row.parentUuid !== undefined) this.unorphan(row.parentUuid, row);
      if (row.uuid === undefined) continue;
      count(this.uuids, row.uuid, -1);
      this.seeded.delete(row.uuid);
      this.seeded.set(row.uuid, this.appendedRows);
    }
    if (this.head * 2 > this.walked.length) {
      this.walked = this.walked.slice(this.head);
      this.head = 0;
    }
    for (const [uuid, at] of this.seeded) {
      if (this.appendedRows - at < patience) break;
      this.seeded.delete(uuid);
      if (!this.uuids.has(uuid)) this.turns.delete(uuid);
    }
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
