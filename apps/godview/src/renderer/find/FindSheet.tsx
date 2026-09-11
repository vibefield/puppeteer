import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { HistorySearchHit, HistorySearchStatus, HistorySessionFacts, PuppeteerBridge } from '../../protocol.js';
import { AgentIcon } from '../AgentIcon.js';
import type { MonitorAgent } from '../monitor/types.js';
import {
  FIND_DEBOUNCE_MS,
  FIND_MAX_SNIPPETS,
  buildFindRows,
  footSentence,
  isCursorKey,
  liveScope,
  moveCursor,
  parseSnippet,
  whenLabel,
  whoSaidIt,
  type FindRow,
} from './find-model.js';

/**
 * The Find sheet: a tool held over the stage, summoned with ⌘F, that answers
 * "which of these agents was the one where I said…". Rows are live agents;
 * under each, the transcript lines that matched are evidence. Picking a row
 * mounts that agent's terminal and puts the sheet away, leaving the stage as
 * it was. What lands where is `find-model.ts`; this file only draws it and
 * talks to the bridge.
 */

export interface FindHistoryBridge {
  status: PuppeteerBridge['historyStatus'];
  facts: PuppeteerBridge['historyFacts'];
  search: PuppeteerBridge['historySearch'];
}

export interface FindSheetProps {
  open: boolean;
  agents: readonly MonitorAgent[];
  onClose(): void;
  onSelect(agent: MonitorAgent): void;
  /** The daemon bridge; the preload's by default, injected by tests. */
  history?: FindHistoryBridge;
  nowMs?: number;
}

const FACTS_REFRESH_MS = 30_000;
const LIST_ID = 'vf-find-listbox';

function optionId(index: number): string {
  return `vf-find-option-${index}`;
}

function bridgeFromWindow(): FindHistoryBridge | undefined {
  const bridge = typeof window === 'undefined' ? undefined : window.puppeteer;
  if (!bridge || typeof bridge.historySearch !== 'function') return undefined;
  return {
    status: () => bridge.historyStatus(),
    facts: (ids) => bridge.historyFacts(ids),
    search: (request) => bridge.historySearch(request),
  };
}

function Snippet({ text }: { text: string }) {
  return (
    <>
      {parseSnippet(text).map((segment, index) =>
        segment.match ? <mark key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>,
      )}
    </>
  );
}

function FindRowView({
  row,
  index,
  active,
  nowMs,
  onHover,
  onPick,
}: {
  row: FindRow;
  index: number;
  active: boolean;
  nowMs: number;
  onHover(): void;
  onPick(): void;
}) {
  const { agent } = row;
  const facet = agent.agent;
  const title = row.title ?? agent.project;
  const place = [row.title ? agent.project : undefined, facet?.branch].filter(Boolean).join(' · ');
  const model = facet ? (facet.model ?? facet.provider.label) : 'terminal';
  const speaker = facet?.provider.label ?? 'agent';
  const style = { '--agent-color': agent.color } as CSSProperties;
  return (
    <li
      id={optionId(index)}
      role="option"
      aria-selected={active}
      aria-label={`${title}, ${agent.project}${facet?.branch ? ` on ${facet.branch}` : ''}, ${model}, ${agent.status}`}
      className={`vf-find-row is-${agent.status}${active ? ' is-active' : ''}`}
      style={style}
      onMouseMove={onHover}
      onClick={onPick}
    >
      <div className="vf-find-row-head">
        <span className="vf-find-status" aria-hidden="true" />
        <span className="vf-find-row-title">
          {title}
          {place ? <small>{place}</small> : null}
        </span>
        <span className="vf-find-row-meta">
          {facet ? (
            <i aria-hidden="true">
              <AgentIcon providerId={facet.provider.id} />
            </i>
          ) : null}
          {model}
          {facet?.account ? ` · ${facet.account}` : ''}
          {` · ${whenLabel(row.lastActiveMs, nowMs)}`}
        </span>
      </div>
      {row.hits.length > 0 ? (
        <ul className="vf-find-evidence">
          {row.hits.slice(0, FIND_MAX_SNIPPETS).map((hit) => (
            <li key={hit.timelineId}>
              <span>{whoSaidIt(hit.kind, speaker)}</span>
              <span>{whenLabel(hit.at, nowMs)}</span>
              <span>
                <Snippet text={hit.snippet} />
              </span>
            </li>
          ))}
          {row.hits.length > FIND_MAX_SNIPPETS ? (
            <li className="is-more">
              <span />
              <span />
              <span>{row.hits.length - FIND_MAX_SNIPPETS} more</span>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

export function FindSheet({ open, agents, onClose, onSelect, history, nowMs }: FindSheetProps) {
  const bridge = useMemo(() => history ?? bridgeFromWindow(), [history]);
  const [query, setQuery] = useState('');
  const [facts, setFacts] = useState<ReadonlyMap<string, HistorySessionFacts>>(() => new Map());
  const [status, setStatus] = useState<HistorySearchStatus>();
  const [hits, setHits] = useState<readonly HistorySearchHit[]>([]);
  const [answered, setAnswered] = useState(true);
  const [clipped, setClipped] = useState(false);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const [clock, setClock] = useState(() => nowMs ?? Date.now());
  const sequence = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const scope = useMemo(() => liveScope(agents), [agents]);
  const scopeKey = scope.nativeSessionIds.join('\n');

  // Titles and readiness: on open, whenever the live set changes, and on a
  // slow cadence while open, so a session that gets named shows its name.
  useEffect(() => {
    if (!open || !bridge) return;
    let alive = true;
    const load = (): void => {
      void bridge
        .status()
        .then((next) => {
          if (alive) setStatus(next);
        })
        .catch(() => undefined);
      if (scope.nativeSessionIds.length === 0) return;
      void bridge
        .facts(scope.nativeSessionIds)
        .then((rows) => {
          if (alive) setFacts(new Map(rows.map((row) => [row.nativeSessionId, row] as const)));
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, FACTS_REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
    // The scope key is the live set's identity; the array itself is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bridge, scopeKey]);

  // Words: one debounced question per keystroke. A late answer to an older
  // question is ignored, and a daemon that had no answer leaves the last hits
  // in place rather than blanking the list.
  useEffect(() => {
    if (!open || !bridge) return;
    const trimmed = query.trim();
    if (trimmed === '') {
      setHits([]);
      setClipped(false);
      setSearching(false);
      setAnswered(true);
      return;
    }
    sequence.current += 1;
    const mine = sequence.current;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void bridge
        .search({
          query: trimmed,
          nativeSessionIds: scope.nativeSessionIds,
          ...(scope.afterMs !== undefined ? { afterMs: scope.afterMs } : {}),
          prefix: true,
        })
        .then((response) => {
          if (mine !== sequence.current) return;
          setStatus(response.status);
          setAnswered(response.answered);
          if (response.answered) {
            setHits(response.hits);
            setClipped(response.clipped);
          }
          setSearching(false);
        })
        .catch(() => {
          if (mine !== sequence.current) return;
          setAnswered(false);
          setSearching(false);
        });
    }, FIND_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bridge, query, scopeKey]);

  // Opening focuses the field with the last query selected, so typing
  // replaces it. The clock is set here and nowhere else: a state write keyed
  // on a callback prop would re-run on every render of the shell.
  useEffect(() => {
    if (!open) return;
    setClock(nowMs ?? Date.now());
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, nowMs]);

  // Escape puts the sheet away from anywhere in the window.
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [open, onClose]);

  const rows = useMemo(
    () => buildFindRows({ agents, facts, hits, query, nowMs: clock }),
    [agents, facts, hits, query, clock],
  );
  // New rows put the cursor on the first one, so Enter lands at once. Keyed on
  // the rows' identities, not the array, which is rebuilt on every clock tick.
  const rowsKey = rows.map((row) => row.agent.id).join('\n');
  useEffect(() => {
    setActive(rowsKey === '' ? -1 : 0);
  }, [rowsKey]);

  if (!open) return null;

  const hitCount = rows.reduce((total, row) => total + row.hits.length, 0);
  const sentence = footSentence({
    query,
    ...(status ? { status } : {}),
    rows: rows.length,
    hits: hitCount,
    scope: scope.nativeSessionIds.length,
    answered,
    clipped,
    searching,
  });
  const source = status?.reachable ? `HISTORY v${status.protocolVersion ?? '?'}` : 'HISTORY OFF';
  const activeRow = active >= 0 ? rows[active] : undefined;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (isCursorKey(event.key)) {
      event.preventDefault();
      const key = event.key;
      setActive((current) => moveCursor(current, key, rows.length));
      return;
    }
    if (event.key === 'Enter' && activeRow) {
      event.preventDefault();
      onSelect(activeRow.agent);
    }
  };

  return (
    <div className="vf-find-sheet" id="vf-find-sheet" role="dialog" aria-label="Find an agent by what was said">
      <div className="vf-find-field">
        <span>FIND</span>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={LIST_ID}
          aria-autocomplete="list"
          {...(activeRow ? { 'aria-activedescendant': optionId(active) } : {})}
          placeholder={`Words you said or heard, or a folder, branch, model — ${scope.nativeSessionIds.length} live sessions`}
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <kbd>ESC</kbd>
        <button type="button" aria-label="Close find" onClick={onClose}>
          ×
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="vf-find-empty">
          {query.trim() === '' ? 'NO LIVE AGENTS' : searching && !answered ? 'SEARCHING' : 'NO LIVE AGENT MATCHES'}
        </div>
      ) : (
        <ul className="vf-find-list" id={LIST_ID} role="listbox" aria-label="Matching agents">
          {rows.map((row, index) => (
            <FindRowView
              key={row.agent.id}
              row={row}
              index={index}
              active={index === active}
              nowMs={clock}
              onHover={() => setActive(index)}
              onPick={() => onSelect(row.agent)}
            />
          ))}
        </ul>
      )}
      <div className="vf-find-foot">
        <span>{source}</span>
        <span title={sentence}>{sentence}</span>
      </div>
    </div>
  );
}
