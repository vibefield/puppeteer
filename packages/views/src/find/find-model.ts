import type { HistorySearchHit, HistorySearchStatus, HistorySessionFacts } from './history-port.js';
import type { FindAgent } from './find-agent.js';

/**
 * The Find sheet's model: everything it decides without a DOM.
 *
 * Two lanes feed one list. The facts lane matches instantly and locally over
 * what the shell already knows about a live run: its transcript title, folder,
 * branch, model, account, status. The words lane asks the transcript history
 * daemon for prompts and replies. The unit of the list is the AGENT, because
 * choosing a row lands the reader in a terminal, not on a message; the hits are
 * evidence under the row, not rows of their own. Rendering is `FindSheet.tsx`.
 */

export const FIND_DEBOUNCE_MS = 120;
export const FIND_MAX_SNIPPETS = 3;
/** Live runs may have been resumed; a little slack keeps their first words in scope. */
const SCOPE_SLACK_MS = 5 * 60_000;

/** The provider-native id a live row joins on, once its provider has said one. */
export function nativeSessionIdOf(agent: FindAgent): string | undefined {
  const facet = agent.agent;
  if (!facet) return undefined;
  // A host's mirror is Core's passthrough: `session` is not promised (build-mv M47).
  return facet.nativeSessionId || facet.monitor?.session?.nativeSessionId || undefined;
}

export interface FindScope {
  nativeSessionIds: string[];
  afterMs?: number;
}

/** Shared only within one projection pass: agents often carry the same
 * evidence clock. The next pass reads timestamps afresh; nothing accumulates. */
function timestampReader(): (value: string) => number {
  const parsed = new Map<string, number>();
  return (value) => {
    const held = parsed.get(value);
    if (held !== undefined) return held;
    const time = Date.parse(value);
    parsed.set(value, time);
    return time;
  };
}

/** What to ask the daemon about: the live runs' native ids and their earliest start. */
export function liveScope(agents: readonly FindAgent[]): FindScope {
  const nativeSessionIds: string[] = [];
  const seen = new Set<string>();
  const readTimestamp = timestampReader();
  let earliest = Number.POSITIVE_INFINITY;
  for (const agent of agents) {
    const id = nativeSessionIdOf(agent);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    nativeSessionIds.push(id);
    const started = agent.agent?.monitor?.session?.startedAt ?? agent.agent?.monitor?.statusSince;
    const startedMs = started ? readTimestamp(started) : Number.NaN;
    const createdMs = agent.createdAtMs;
    const candidate = Number.isFinite(startedMs) ? Math.min(startedMs, createdMs) : createdMs;
    if (Number.isFinite(candidate)) earliest = Math.min(earliest, candidate);
  }
  return {
    nativeSessionIds,
    ...(Number.isFinite(earliest) ? { afterMs: Math.max(0, earliest - SCOPE_SLACK_MS) } : {}),
  };
}

/* ── the facts lane ────────────────────────────────────────────────────── */

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/^"+|"+$/g, ''))
    .filter((term) => term.length > 0);
}

function isWordStart(haystack: string, index: number): boolean {
  return index === 0 || /[^a-z0-9]/.test(haystack[index - 1] ?? '');
}

/**
 * How well one field answers one term: a word start beats a substring beats an
 * acronym. The loose form is deliberately narrow: each letter must continue
 * the previous match or begin a word (`ice` finds `infinite-canvas-engine`,
 * `pte` does not find `puppeteer`), and nothing shorter than three characters
 * may match loosely, or `vf` would light up every row.
 */
export function fieldMatch(field: string, term: string): number {
  const haystack = field.toLowerCase();
  if (haystack === '' || term === '') return 0;
  const at = haystack.indexOf(term);
  if (at >= 0 && isWordStart(haystack, at)) return 3;
  if (at > 0) return 2;
  if (term.length < 3) return 0;
  let cursor = 0;
  for (const char of term) {
    let next = haystack.indexOf(char, cursor);
    while (next >= 0 && next !== cursor && !isWordStart(haystack, next)) next = haystack.indexOf(char, next + 1);
    if (next < 0) return 0;
    cursor = next + 1;
  }
  return 1;
}

interface FactsField {
  name: string;
  value: string;
  weight: number;
}

function factsFields(agent: FindAgent, facts: HistorySessionFacts | undefined): FactsField[] {
  const facet = agent.agent;
  const fields: FactsField[] = [];
  const push = (name: string, value: string | undefined, weight: number): void => {
    if (value) fields.push({ name, value, weight });
  };
  push('title', facts?.title, 3);
  push('summary', facts?.summary, 1.5);
  push('project', agent.project, 3);
  push('branch', facet?.branch, 2);
  push('model', facet?.model, 1.5);
  push('provider', facet?.provider.label, 1.5);
  push('account', facet?.account, 1);
  push('status', agent.status, 1);
  push('detail', agent.detail, 1);
  return fields;
}

export interface FactsScore {
  score: number;
  matched: string[];
}

/** Every term must land on some field; the score is the best field per term, weighted. */
export function factsScore(
  agent: FindAgent,
  facts: HistorySessionFacts | undefined,
  terms: readonly string[],
): FactsScore {
  if (terms.length === 0) return { score: 0, matched: [] };
  const fields = factsFields(agent, facts);
  let total = 0;
  const matched = new Set<string>();
  for (const term of terms) {
    let best = 0;
    let bestField: string | undefined;
    for (const field of fields) {
      const quality = fieldMatch(field.value, term) * field.weight;
      if (quality > best) {
        best = quality;
        bestField = field.name;
      }
    }
    if (best === 0 || !bestField) return { score: 0, matched: [] };
    total += best;
    matched.add(bestField);
  }
  return { score: total, matched: [...matched] };
}

/* ── rows ──────────────────────────────────────────────────────────────── */

export interface FindRow<Agent extends FindAgent = FindAgent> {
  agent: Agent;
  nativeSessionId?: string;
  facts?: HistorySessionFacts;
  /** The transcript's own title, when the daemon has one. */
  title?: string;
  factsScore: number;
  matched: string[];
  /** Newest first; the sheet shows the first few and says how many there are. */
  hits: HistorySearchHit[];
  score: number;
  lastActiveMs: number;
}

function activityTime(agent: FindAgent, nowMs: number, readTimestamp: (value: string) => number): number {
  const monitor = agent.agent?.monitor;
  let latest = Number.NEGATIVE_INFINITY;
  const evidence = monitor?.freshness?.lastEvidenceAt;
  const evidenceMs = evidence ? readTimestamp(evidence) : Number.NaN;
  if (Number.isFinite(evidenceMs) && evidenceMs <= nowMs + 60_000) latest = evidenceMs;
  const status = monitor?.statusSince;
  const statusMs = status ? readTimestamp(status) : Number.NaN;
  if (Number.isFinite(statusMs) && statusMs <= nowMs + 60_000) latest = Math.max(latest, statusMs);
  return latest === Number.NEGATIVE_INFINITY ? agent.createdAtMs : latest;
}

export function lastActiveMs(agent: FindAgent, nowMs: number): number {
  return activityTime(agent, nowMs, Date.parse);
}

function recencyBoost(lastActive: number, nowMs: number): number {
  const age = nowMs - lastActive;
  if (age < 10 * 60_000) return 3;
  if (age < 60 * 60_000) return 2;
  if (age < 24 * 60 * 60_000) return 1;
  return 0;
}

export interface BuildFindRowsInput<Agent extends FindAgent = FindAgent> {
  agents: readonly Agent[];
  facts: ReadonlyMap<string, HistorySessionFacts>;
  hits: readonly HistorySearchHit[];
  query: string;
  nowMs: number;
}

const NO_HITS: readonly HistorySearchHit[] = Object.freeze([]);

interface HeldFindRow<Agent extends FindAgent> {
  readonly facts: HistorySessionFacts | undefined;
  readonly title: string | undefined;
  readonly summary: string | undefined;
  readonly hits: readonly HistorySearchHit[];
  readonly terms: readonly string[];
  readonly nowMs: number;
  readonly row: FindRow<Agent> | null;
}

/** One compiler per sheet. Readonly live rows keep their work while their
 * history, query and clock inputs stand. Every call still ranks the current
 * set, including while closed, so cursor resets and reopen behavior agree.
 * History facts/hits may be mutable: inspect title/summary and regroup/sort
 * hits every pass. The public stateless builder below keeps fresh outputs. */
export function createFindRows<Agent extends FindAgent>(): (input: BuildFindRowsInput<Agent>) => FindRow<Agent>[] {
  const cached = new WeakMap<Agent, HeldFindRow<Agent>>();
  let lastQuery: string | undefined;
  let terms: readonly string[] = [];
  return ({ agents, facts, hits, query, nowMs }) => {
    if (query !== lastQuery) {
      terms = tokenize(query);
      lastQuery = query;
    }
    const hitsByNative = new Map<string, HistorySearchHit[]>();
    for (const hit of hits) {
      if (!hit.nativeSessionId) continue;
      const list = hitsByNative.get(hit.nativeSessionId);
      if (list) list.push(hit);
      else hitsByNative.set(hit.nativeSessionId, [hit]);
    }
    for (const list of hitsByNative.values()) list.sort((left, right) => (right.at ?? 0) - (left.at ?? 0));
    const readTimestamp = timestampReader();
    const rows: FindRow<Agent>[] = [];
    for (const agent of agents) {
      const nativeSessionId = nativeSessionIdOf(agent);
      const known = nativeSessionId ? facts.get(nativeSessionId) : undefined;
      const ordered = (nativeSessionId ? hitsByNative.get(nativeSessionId) : undefined) ?? NO_HITS;
      const held = cached.get(agent);
      if (
        held !== undefined &&
        held.facts === known &&
        held.title === known?.title &&
        held.summary === known?.summary &&
        held.hits === ordered &&
        held.terms === terms &&
        held.nowMs === nowMs
      ) {
        if (held.row !== null) rows.push(held.row);
        continue;
      }
      const { score: factScore, matched } = factsScore(agent, known, terms);
      let row: FindRow<Agent> | null = null;
      if (!(terms.length > 0 && factScore === 0 && ordered.length === 0) && !(terms.length === 0 && !agent.agent)) {
        const active = activityTime(agent, nowMs, readTimestamp);
        const score =
          factScore * 10 +
          (ordered.length > 0 ? 6 : 0) +
          Math.min(ordered.length, 5) * 4 +
          recencyBoost(active, nowMs) +
          (agent.status === 'blocked' ? 1 : 0);
        row = {
          agent,
          ...(nativeSessionId ? { nativeSessionId } : {}),
          ...(known ? { facts: known } : {}),
          ...(known?.title ? { title: known.title } : {}),
          factsScore: factScore,
          matched,
          hits: [...ordered],
          score,
          lastActiveMs: active,
        };
        rows.push(row);
      }
      cached.set(agent, {
        facts: known,
        title: known?.title,
        summary: known?.summary,
        hits: ordered,
        terms,
        nowMs,
        row,
      });
    }
    return rows.sort(
      (left, right) =>
        right.score - left.score ||
        right.lastActiveMs - left.lastActiveMs ||
        left.agent.project.localeCompare(right.agent.project),
    );
  };
}

export function buildFindRows<Agent extends FindAgent>(input: BuildFindRowsInput<Agent>): FindRow<Agent>[] {
  return createFindRows<Agent>()(input);
}

/* ── the words on a row ────────────────────────────────────────────────── */

export interface SnippetSegment {
  text: string;
  match: boolean;
}

/** `[` and `]` mark matches; whitespace collapses; an unbalanced marker is just text. */
export function parseSnippet(snippet: string): SnippetSegment[] {
  const collapsed = snippet.replace(/\s+/g, ' ').trim();
  const segments: SnippetSegment[] = [];
  let buffer = '';
  let inMatch = false;
  const flush = (): void => {
    if (buffer !== '') {
      const last = segments[segments.length - 1];
      if (last && last.match === inMatch) last.text += buffer;
      else segments.push({ text: buffer, match: inMatch });
    }
    buffer = '';
  };
  for (const char of collapsed) {
    if (char === '[' && !inMatch) {
      flush();
      inMatch = true;
    } else if (char === ']' && inMatch) {
      flush();
      inMatch = false;
    } else {
      buffer += char;
    }
  }
  if (inMatch) {
    // Never closed: the bracket was text after all.
    buffer = `[${buffer}`;
    inMatch = false;
  }
  flush();
  return segments;
}

/** Who said it, in the room's own words. */
export function whoSaidIt(kind: string, agentLabel: string): string {
  if (kind === 'user') return 'you';
  if (kind === 'agent') return agentLabel;
  return kind;
}

const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** The clock inside today, the day and clock inside the year, the day and year beyond it. */
export function whenLabel(atMs: number | undefined, nowMs: number): string {
  if (atMs === undefined || !Number.isFinite(atMs)) return '—';
  const date = new Date(atMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const today = startOfDay(nowMs);
  if (atMs >= today && atMs < today + DAY_MS) return clock;
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  if (date.getFullYear() === new Date(nowMs).getFullYear()) return `${day} · ${clock}`;
  return `${day} ${date.getFullYear()}`;
}

/* ── the sentence in the foot ──────────────────────────────────────────── */

export interface FootInput {
  query: string;
  status?: HistorySearchStatus;
  rows: number;
  hits: number;
  scope: number;
  answered: boolean;
  clipped: boolean;
  /** A search is in flight and nothing has answered yet. */
  searching: boolean;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Degraded is ordinary here: the foot says exactly what the daemon can and cannot answer. */
export function footSentence(input: FootInput): string {
  const { status } = input;
  const words = status?.reachable
    ? status.readiness === 'building'
      ? status.progress && status.progress.total > 0
        ? `indexing · ${Math.floor((100 * status.progress.done) / status.progress.total)}%`
        : 'index being prepared'
      : status.readiness === 'catching-up'
        ? 'catching up'
        : status.readiness === 'stale' || status.readiness === 'failed'
          ? 'transcript search unavailable'
          : undefined
    : status
      ? `transcript search off · ${status.detail ?? 'no daemon'}`
      : undefined;
  if (input.query.trim() === '') {
    return [plural(input.scope, 'live session'), words].filter(Boolean).join(' · ');
  }
  const parts = [plural(input.rows, 'agent'), plural(input.hits, 'match', 'matches')];
  if (input.searching && !input.answered) parts.push('searching');
  if (input.clipped) parts.push('first page only · narrow the search');
  if (status?.detail && status.reachable) parts.push(status.detail);
  if (words) parts.push(words);
  return parts.join(' · ');
}

/* ── the keyboard cursor ───────────────────────────────────────────────── */

export type CursorKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

export function isCursorKey(key: string): key is CursorKey {
  return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End';
}

/** Listbox arithmetic: no wrap, clamped at both ends. */
export function moveCursor(active: number, key: CursorKey, count: number): number {
  if (count <= 0) return -1;
  const last = count - 1;
  const from = active < 0 ? -1 : Math.min(active, last);
  switch (key) {
    case 'ArrowDown':
      return Math.min(last, from + 1);
    case 'ArrowUp':
      return Math.max(0, from - 1);
    case 'Home':
      return 0;
    case 'End':
      return last;
  }
}
