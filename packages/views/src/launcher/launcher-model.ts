import {
  FIND_DEBOUNCE_MS,
  fieldMatch,
  parseSnippet,
  tokenize,
  whoSaidIt,
  type SnippetSegment,
} from '../find/find-model.js';
import { folderName } from '../monitor/folder-name.js';
import type { LauncherAgent, LauncherHistoryStatus, LauncherSession, LauncherWordHit } from './launcher-port.js';

/**
 * The empty pane launcher's model (QL-1, Minimal Pane Frame pass 3 §17–§25):
 * everything it decides without a DOM. The agents in their launch order with
 * their keys, what a key does in each state, the past sessions matched and
 * grouped, and every sentence the launcher says. `PaneLauncherChrome.tsx` draws
 * it; `DeckLaunchers.tsx` owns the keys and the state.
 */

/** Ten rows at most: ⌥1 … ⌥9, then ⌥0. */
export const LAUNCHER_MAX_AGENTS = 10;
/** With nothing typed, the field lists this folder's latest five (§23). */
export const LAUNCHER_LATEST_LIMIT = 5;
/** A search keeps this many rows per group; the list scrolls inside itself. */
export const LAUNCHER_GROUP_LIMIT = 12;
/** How many sessions a launcher asks its host for. */
export const LAUNCHER_RECENT_LIMIT = 100;
/** One debounced question to the words lane per pause in typing, as Find asks. */
export const LAUNCHER_SEARCH_DEBOUNCE_MS = FIND_DEBOUNCE_MS;
/** The narrow tiers (§22): marks with keys · five marks · the field alone. */
export const LAUNCHER_NARROW_WIDTHS = { marks: 340, five: 250, field: 190 } as const;
/** Under this height the agents become one row of marks. */
export const LAUNCHER_SHORT_HEIGHT = 220;

export type LauncherScope = 'here' | 'all';

/* ── the agents ────────────────────────────────────────────────────────── */

/**
 * The last launch per agent first; an agent never launched keeps the host's
 * catalog order behind them, and so do ties. Ordering compares timestamps and
 * positions only — never a provider id.
 */
export function orderAgents(agents: readonly LauncherAgent[]): LauncherAgent[] {
  return agents
    .map((agent, index) => ({ agent, index }))
    .sort((left, right) => {
      const l = left.agent.lastLaunchedAt;
      const r = right.agent.lastLaunchedAt;
      const lKnown = l !== undefined && Number.isFinite(l);
      const rKnown = r !== undefined && Number.isFinite(r);
      if (lKnown && rKnown && l !== r) return r - l;
      if (lKnown !== rKnown) return lKnown ? -1 : 1;
      return left.index - right.index;
    })
    .slice(0, LAUNCHER_MAX_AGENTS)
    .map(({ agent }) => agent);
}

/** The digit a row answers to: index 0 → 1 … index 8 → 9, index 9 → 0. */
export function agentDigit(index: number): string {
  return String((index + 1) % 10);
}

/** The key as the legend prints it: `⌥1`. */
export function agentKeyLabel(index: number): string {
  return `⌥${agentDigit(index)}`;
}

/** The key as `aria-keyshortcuts` says it: `Alt+1`. */
export function agentKeyShortcut(index: number): string {
  return `Alt+${agentDigit(index)}`;
}

/** The row index a `KeyboardEvent.code` names (`Digit1` → 0, `Digit0` → 9), by position, never by the typed character. */
export function digitCodeIndex(code: string): number | undefined {
  const match = /^Digit([0-9])$/.exec(code);
  if (!match) return undefined;
  const digit = Number(match[1]);
  return digit === 0 ? 9 : digit - 1;
}

/** What the preview line says for an agent: the host's words, else its label. */
export function agentPreview(agent: LauncherAgent): string {
  return agent.preview ?? agent.label;
}

/* ── the gate (QL-D7) ──────────────────────────────────────────────────── */

export interface LauncherGateInput {
  /** Shells born in this view with no agent facet, not exited (QL-D7 a–c, the host's call). */
  freshSessionIds: ReadonlySet<string>;
  /** Sessions the launcher saw input reach: a key it let through, or a paste (QL-D7 d). */
  used: ReadonlySet<string>;
  /** Sessions whose launcher was put away with ⎋, or left after a launch or a resume. */
  dismissed: ReadonlySet<string>;
  /** The host's own knowledge of input, when it has any. */
  hasInput?: ((sessionId: string) => boolean) | undefined;
}

/** Whether a pane showing this session draws the launcher. */
export function showsLauncher(sessionId: string, gate: LauncherGateInput): boolean {
  return (
    gate.freshSessionIds.has(sessionId) &&
    !gate.used.has(sessionId) &&
    !gate.dismissed.has(sessionId) &&
    gate.hasInput?.(sessionId) !== true
  );
}

/* ── the keys (§23, QL-D2) ─────────────────────────────────────────────── */

/** The fields of a `KeyboardEvent` the reducer reads. */
export interface LauncherKeyEvent {
  code: string;
  key: string;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean | undefined;
}

export interface LauncherKeyState {
  /** The field is open (focused). */
  open: boolean;
  /** How many agent rows are listed. */
  agentCount: number;
  /** The highlighted result's index, -1 for none. */
  highlight: number;
  /** Whether the highlighted result can be resumed. */
  highlightResumable: boolean;
  /** A launch or a resume is in flight: the shell it replaces is about to close. */
  launching?: boolean | undefined;
}

export type LauncherKeyAction =
  /** Not the launcher's: the key goes where it was going and the launcher stays. */
  | { kind: 'ignore' }
  /** Input for the shell: the key reaches it and the launcher goes. */
  | { kind: 'used' }
  /** The field's own typing: the input takes it. */
  | { kind: 'type' }
  | { kind: 'launch'; index: number }
  | { kind: 'open' }
  | { kind: 'dismiss' }
  | { kind: 'close' }
  | { kind: 'move'; delta: 1 | -1 }
  | { kind: 'resume'; index: number }
  | { kind: 'toggle-scope' }
  /** The launcher's key, with nothing to do (a digit with no agent, ↵ on a row it withholds). */
  | { kind: 'hold' };

const MODIFIER_KEYS = new Set([
  'Alt',
  'AltGraph',
  'CapsLock',
  'Control',
  'Fn',
  'FnLock',
  'Hyper',
  'Meta',
  'NumLock',
  'OS',
  'ScrollLock',
  'Shift',
  'Super',
  'Symbol',
  'SymbolLock',
]);

function isEnter(event: LauncherKeyEvent): boolean {
  return event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter';
}

/** ⌥ with a digit, and no other modifier: launch that row (or hold, past the last). */
function digitAction(event: LauncherKeyEvent, state: LauncherKeyState): LauncherKeyAction | undefined {
  if (!event.altKey || event.shiftKey || event.metaKey || event.ctrlKey) return undefined;
  const index = digitCodeIndex(event.code);
  if (index === undefined) return undefined;
  return index < state.agentCount ? { kind: 'launch', index } : { kind: 'hold' };
}

/**
 * What one key does to a launcher in the focused pane. Closed, the launcher
 * owns ⌥0–⌥9, ⌥↵ and ⎋; ⌘/⌃ chords and bare modifiers pass by untouched;
 * any other key is the shell's and dismisses the launcher on its way through.
 * Open, the field owns ↑↓ ↵ ⇥ ⎋ and the ⌥ digits (§25's "⌥1–⌥0 still launch
 * new agents" is said with the field open), and the rest is its typing. Digits
 * are read from `event.code`: macOS types ¡™£ for ⌥1 ⌥2 ⌥3. An IME composition
 * is never interrupted. While a launch or a resume is in flight every other
 * key is held, so nothing reaches the shell that is about to close; ⌘/⌃ chords
 * and bare modifiers still pass, and a refusal returns the launcher to rest.
 */
export function launcherKeyAction(event: LauncherKeyEvent, state: LauncherKeyState): LauncherKeyAction {
  const composing = event.isComposing === true || event.key === 'Process';
  if (state.launching) {
    if (MODIFIER_KEYS.has(event.key) || event.metaKey || event.ctrlKey) return { kind: 'ignore' };
    return { kind: 'hold' };
  }
  if (!state.open) {
    if (composing) return { kind: 'used' };
    if (MODIFIER_KEYS.has(event.key)) return { kind: 'ignore' };
    if (event.metaKey || event.ctrlKey) return { kind: 'ignore' };
    const digit = digitAction(event, state);
    if (digit) return digit;
    if (event.altKey && !event.shiftKey && isEnter(event)) return { kind: 'open' };
    if (event.key === 'Escape') return { kind: 'dismiss' };
    return { kind: 'used' };
  }
  if (composing) return { kind: 'type' };
  const digit = digitAction(event, state);
  if (digit) return digit;
  if (event.metaKey || event.ctrlKey) return { kind: 'type' };
  if (event.key === 'Escape') return { kind: 'close' };
  if (event.altKey) return { kind: 'type' };
  if (event.key === 'ArrowDown') return { kind: 'move', delta: 1 };
  if (event.key === 'ArrowUp') return { kind: 'move', delta: -1 };
  if (event.key === 'Tab') return { kind: 'toggle-scope' };
  if (isEnter(event) && !event.shiftKey) {
    if (state.highlight >= 0 && state.highlightResumable) return { kind: 'resume', index: state.highlight };
    return { kind: 'hold' };
  }
  return { kind: 'type' };
}

/** Whether the launcher takes the key from everyone after it (`preventDefault` + `stopImmediatePropagation`). */
export function consumesKey(action: LauncherKeyAction): boolean {
  return action.kind !== 'ignore' && action.kind !== 'used' && action.kind !== 'type';
}

/* ── the mounter's routing (DeckLaunchers) ─────────────────────────────── */

/** A pane that shows a launcher, as the mounter's key listener sees it. */
export interface LauncherKeyPane {
  paneId: string;
  sessionId: string;
  element: { contains(node: Node | null): boolean };
}

/**
 * The launcher a key belongs to: the one in the pane that holds the key's
 * target, whether or not the workspace calls that pane active (a click can
 * put the keyboard in a pane before, or without, its activation). A key aimed
 * anywhere else is none of the launchers' business.
 */
export function launcherPaneForTarget<Pane extends LauncherKeyPane>(
  target: Node | null,
  panes: readonly Pane[],
): Pane | undefined {
  if (!target) return undefined;
  return panes.find((pane) => pane.element.contains(target));
}

/** What the mounter does with one key after `launcherKeyAction` has named it. */
export interface LauncherKeyDecision {
  /** Take the key from everyone after the launcher (`preventDefault` + `stopImmediatePropagation`). */
  consume: boolean;
  /** Take the key's release too, so no one sees a keyup whose keydown they never saw. */
  release: boolean;
  /**
   * `none`: nothing more. `used`: the shell has input, so the launcher goes.
   * `dismiss`: put away with ⎋. `apply`: the launcher acts on `action`.
   */
  effect: 'none' | 'used' | 'dismiss' | 'apply';
  action: LauncherKeyAction;
}

/** One key for a launcher, decided whole: whether it is taken, its release too, and what follows. */
export function launcherKeyDecision(event: LauncherKeyEvent, state: LauncherKeyState): LauncherKeyDecision {
  const action = launcherKeyAction(event, state);
  const consume = consumesKey(action);
  const release = consume && !MODIFIER_KEYS.has(event.key);
  switch (action.kind) {
    case 'ignore':
    case 'type':
    case 'hold':
      return { consume, release, effect: 'none', action };
    case 'used':
      return { consume, release, effect: 'used', action };
    case 'dismiss':
      return { consume, release, effect: 'dismiss', action };
    default:
      return { consume, release, effect: 'apply', action };
  }
}

/**
 * The key codes whose press a launcher took, so their releases are taken too.
 * A release is taken once, wherever it lands: the launcher may have left by then.
 */
export class LauncherKeyReleases {
  readonly #pending = new Set<string>();

  took(code: string): void {
    if (code) this.#pending.add(code);
  }

  /** Whether this release is the launcher's; true at most once per press taken. */
  released(code: string): boolean {
    return this.#pending.delete(code);
  }
}

/** The highlight after a move: clamped at both ends, like Find's cursor. */
export function moveHighlight(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, current + delta));
}

export function toggleScope(scope: LauncherScope): LauncherScope {
  return scope === 'here' ? 'all' : 'here';
}

/* ── words ─────────────────────────────────────────────────────────────── */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function count(value: number, one: string): string {
  return `${value} ${one}${value === 1 ? '' : 's'}`;
}

/** "just now", "5 minutes ago", "2 hours ago", "yesterday", "18 days ago" — by the clock under a day, by the calendar past it. */
export function ageWords(atMs: number | undefined, nowMs: number): string | undefined {
  if (atMs === undefined || !Number.isFinite(atMs)) return undefined;
  const age = nowMs - atMs;
  if (age < MINUTE_MS) return 'just now';
  if (age < HOUR_MS) return `${count(Math.floor(age / MINUTE_MS), 'minute')} ago`;
  if (age < DAY_MS) return `${count(Math.floor(age / HOUR_MS), 'hour')} ago`;
  const days = Math.max(1, Math.round((startOfDay(nowMs) - startOfDay(atMs)) / DAY_MS));
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Counts as the design prints them: `1,204`. */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** The pane's folder as the launcher names it. */
export function launcherFolder(cwd: string | undefined): string {
  return folderName(cwd, 'this folder');
}

export interface LauncherSentence {
  text: string;
  /** The quieter second line. */
  hint: string;
}

/** Whether past sessions cannot be listed at all: the history service is down or failed. */
export function historyUnavailable(status: LauncherHistoryStatus | undefined): boolean {
  return status?.readiness === 'unreachable' || status?.readiness === 'failed';
}

/** The sentence in place of the list when history cannot answer (§22 "history"). */
export function historyUnavailableSentence(status: LauncherHistoryStatus): LauncherSentence {
  const text =
    status.readiness === 'failed'
      ? 'Past sessions can’t be searched: the history index failed.'
      : 'Past sessions can’t be searched: the history service isn’t answering.';
  return { text, hint: '⌥1–⌥0 still launch new agents · ⎋ back to the shell' };
}

export interface HistoryStatusLine {
  text: string;
  /** 0–100 for the track under it; absent draws no track. */
  percent?: number;
}

/** Readiness shown as it is, under the rows found so far; nothing when history is ready. */
export function historyStatusLine(status: LauncherHistoryStatus | undefined): HistoryStatusLine | undefined {
  if (!status) return undefined;
  const { readiness, progress, detail } = status;
  if (readiness === 'building' || readiness === 'catching-up') {
    const head = readiness === 'building' ? 'History is being read' : 'History is catching up';
    if (progress && progress.total > 0) {
      const done = Math.min(progress.done, progress.total);
      return {
        text: `${head} · ${formatCount(done)} of ${formatCount(progress.total)} sessions read`,
        percent: Math.floor((100 * done) / progress.total),
      };
    }
    return { text: head };
  }
  if (readiness === 'stale') return { text: detail ? `History may be behind · ${detail}` : 'History may be behind' };
  return undefined;
}

/** What the field says when nothing matched. */
export function noMatchSentence(query: string, scope: LauncherScope, folder: string): LauncherSentence {
  const quoted = `“${query.trim()}”`;
  return scope === 'here'
    ? { text: `No session in ${folder} mentions ${quoted}.`, hint: '⇥ searches every folder · ⎋ back to the shell' }
    : { text: `No session mentions ${quoted}.`, hint: '⎋ back to the shell' };
}

/** What the field says when there is nothing to list yet. */
export function noSessionsSentence(scope: LauncherScope, folder: string): LauncherSentence {
  return scope === 'here'
    ? { text: `No past sessions in ${folder} yet.`, hint: '⇥ shows every folder · ⎋ back to the shell' }
    : { text: 'No past sessions yet.', hint: '⎋ back to the shell' };
}

/* ── the results ───────────────────────────────────────────────────────── */

export interface LauncherEvidence {
  /** `you`, the agent's label, or the hit's own kind. */
  who: string;
  segments: SnippetSegment[];
}

export interface LauncherResultRow {
  session: LauncherSession;
  /** The mark to draw; absent draws a neutral one. */
  providerId?: string;
  titleSegments: SnippetSegment[];
  /** folder (elsewhere) · agent · branch · why not · age */
  meta: string;
  evidence?: LauncherEvidence;
  score: number;
}

export interface LauncherResultGroup {
  id: 'here' | 'elsewhere';
  /** Written in sentence case; the stylesheet sets it in capitals. */
  label: string;
  rows: LauncherResultRow[];
}

export interface LauncherResults {
  groups: LauncherResultGroup[];
  /** Every row in list order, the highlight's index space. */
  rows: LauncherResultRow[];
}

export interface BuildLauncherResultsInput {
  sessions: readonly LauncherSession[];
  hits: readonly LauncherWordHit[];
  query: string;
  scope: LauncherScope;
  folder: string;
  agents: readonly LauncherAgent[];
  nowMs: number;
}

/** The substrings of `text` each term appears in, marked (loose acronym matches are not). */
export function markTerms(text: string, terms: readonly string[]): SnippetSegment[] {
  const lower = text.toLowerCase();
  const marked = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    if (term === '') continue;
    let at = lower.indexOf(term);
    while (at >= 0) {
      for (let index = at; index < at + term.length; index += 1) marked[index] = true;
      at = lower.indexOf(term, at + term.length);
    }
  }
  const segments: SnippetSegment[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const match = marked[index] === true;
    const last = segments[segments.length - 1];
    if (last && last.match === match) last.text += text[index];
    else segments.push({ text: text[index] ?? '', match });
  }
  return segments;
}

function agentLabelOf(providerId: string | undefined, agents: readonly LauncherAgent[]): string | undefined {
  if (!providerId) return undefined;
  return agents.find((agent) => agent.providerId === providerId)?.label ?? providerId;
}

/** Every term must land on some fact; the score is the best fact per term, weighted (Find's facts lane). */
function sessionFactsScore(session: LauncherSession, label: string | undefined, terms: readonly string[]): number {
  const fields: Array<{ value: string; weight: number }> = [];
  const push = (value: string | undefined, weight: number): void => {
    if (value) fields.push({ value, weight });
  };
  push(session.title, 3);
  push(session.cwd ? folderName(session.cwd, '') : undefined, 3);
  push(label, 1.5);
  push(session.branch, 2);
  let total = 0;
  for (const term of terms) {
    let best = 0;
    for (const field of fields) best = Math.max(best, fieldMatch(field.value, term) * field.weight);
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

function hitFor(session: LauncherSession, hits: readonly LauncherWordHit[]): LauncherWordHit | undefined {
  return hits.find(
    (hit) =>
      (hit.sessionKey !== undefined && hit.sessionKey === session.key) ||
      (hit.nativeSessionId !== undefined && hit.nativeSessionId === session.nativeSessionId),
  );
}

function metaLine(session: LauncherSession, label: string | undefined, elsewhere: boolean, nowMs: number): string {
  return [
    elsewhere && session.cwd ? folderName(session.cwd, '') : undefined,
    label,
    session.branch,
    session.resumable ? undefined : session.unresumable,
    ageWords(session.lastAt, nowMs),
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

function byRecency(left: LauncherResultRow, right: LauncherResultRow): number {
  return (right.session.lastAt ?? 0) - (left.session.lastAt ?? 0);
}

/**
 * The field's list. With nothing typed: this folder's latest five (and, in
 * `all`, the latest five elsewhere). Typed: the facts lane over title, folder,
 * agent and branch, plus any listed session the words lane found, ranked by
 * match and then by recency; a words hit becomes the row's third line. Groups:
 * IN <FOLDER>, then ELSEWHERE in `all` only.
 */
export function buildLauncherResults({
  sessions,
  hits,
  query,
  scope,
  folder,
  agents,
  nowMs,
}: BuildLauncherResultsInput): LauncherResults {
  const terms = tokenize(query);
  const searching = terms.length > 0;
  const here: LauncherResultRow[] = [];
  const elsewhere: LauncherResultRow[] = [];
  for (const session of sessions) {
    if (scope === 'here' && !session.here) continue;
    const label = agentLabelOf(session.providerId, agents);
    const hit = searching ? hitFor(session, hits) : undefined;
    const facts = searching ? sessionFactsScore(session, label, terms) : 0;
    if (searching && facts === 0 && !hit) continue;
    const row: LauncherResultRow = {
      session,
      ...(session.providerId ? { providerId: session.providerId } : {}),
      titleSegments: searching ? markTerms(session.title, terms) : [{ text: session.title, match: false }],
      meta: metaLine(session, label, !session.here, nowMs),
      ...(hit ? { evidence: { who: whoSaidIt(hit.kind, label ?? 'agent'), segments: parseSnippet(hit.snippet) } } : {}),
      score: facts * 10 + (hit ? 6 : 0),
    };
    (session.here ? here : elsewhere).push(row);
  }
  const rank = searching
    ? (left: LauncherResultRow, right: LauncherResultRow) => right.score - left.score || byRecency(left, right)
    : byRecency;
  const limit = searching ? LAUNCHER_GROUP_LIMIT : LAUNCHER_LATEST_LIMIT;
  const groups: LauncherResultGroup[] = [];
  if (here.length > 0) {
    groups.push({
      id: 'here',
      label: searching ? `In ${folder}` : `Latest in ${folder}`,
      rows: here.sort(rank).slice(0, limit),
    });
  }
  if (scope === 'all' && elsewhere.length > 0) {
    groups.push({ id: 'elsewhere', label: 'Elsewhere', rows: elsewhere.sort(rank).slice(0, limit) });
  }
  return { groups, rows: groups.flatMap((group) => group.rows) };
}
