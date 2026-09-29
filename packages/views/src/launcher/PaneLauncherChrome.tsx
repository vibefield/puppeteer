import type {
  CSSProperties,
  FocusEvent as ReactFocusEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
} from 'react';
import type { SnippetSegment } from '../find/find-model.js';
import { AgentIcon } from '../icons/AgentIcon.js';
import { launchSource } from './launch-model.js';
import {
  agentKeyLabel,
  agentKeyShortcut,
  agentPreview,
  historyStatusLine,
  historyUnavailable,
  historyUnavailableSentence,
  noMatchSentence,
  noSessionsSentence,
  type LauncherResults,
  type LauncherScope,
  type LauncherSentence,
} from './launcher-model.js';
import type { LauncherAgent, LauncherHistoryStatus } from './launcher-port.js';

/**
 * What the launcher is doing with a key or a click it acted on. `leaving`: the
 * launch has taken the row's mark and the launcher has shrunk away toward it
 * (QL-2); `returning`: a refused launch is bringing the mark back to its row,
 * which the launcher, back already, keeps empty until it lands.
 */
export type LauncherBusy =
  | { kind: 'launch'; index: number; leaving?: boolean | undefined; returning?: boolean | undefined }
  | { kind: 'resume'; index: number; leaving?: boolean | undefined; returning?: boolean | undefined };

export interface PaneLauncherChromeProps {
  /** The fresh shell's session; names the launcher in `data-vf-pane-launcher`. */
  sessionId: string;
  /** The agents in launch order (`orderAgents`), ten at most. */
  agents: readonly LauncherAgent[];
  /** The pane's folder, as the launcher names it (`launcherFolder`). */
  folder: string;
  /** The pane colour the host dealt this pane. */
  color?: string | undefined;
  /** The pane is the selected one. A resting pane keeps only its field, quietly. */
  active: boolean;
  /** The pane is under `LAUNCHER_SHORT_HEIGHT`: the agents become one row of marks. */
  short?: boolean | undefined;
  /** The field is open (focused): the results replace the agents. */
  open: boolean;
  query: string;
  scope: LauncherScope;
  /** The field's list; absent while nothing has answered yet. */
  results?: LauncherResults | undefined;
  /** The highlighted row in `results.rows`, -1 for none. */
  highlight: number;
  /** The history service's last answer; absent while nothing has answered yet. */
  history?: LauncherHistoryStatus | undefined;
  /** The agent under the pointer, for the pressed/hover look and the preview line. */
  hoverIndex?: number | undefined;
  busy?: LauncherBusy | undefined;
  /** One line under the rows: why a launch or a resume was refused. */
  failure?: string | undefined;
  /**
   * The field's element. An object ref, not `Ref<T>`: a host type-checking
   * this source against its own copy of `@types/react` would otherwise meet
   * two unrelated callback-ref cleanup types (a `unique symbol` each).
   */
  inputRef?: RefObject<HTMLInputElement | null> | undefined;
  onQueryChange?: ((query: string) => void) | undefined;
  onOpen?: (() => void) | undefined;
  onFieldBlur?: ((event: ReactFocusEvent<HTMLInputElement>) => void) | undefined;
  onLaunch?: ((index: number) => void) | undefined;
  onHover?: ((index: number | undefined) => void) | undefined;
  onResume?: ((index: number) => void) | undefined;
  onHighlight?: ((index: number) => void) | undefined;
  onScope?: ((scope: LauncherScope) => void) | undefined;
  /** A pointer anywhere in the launcher, in the capture phase: before any part of it acts. */
  onRootPointerDown?: ((event: ReactPointerEvent<HTMLDivElement>) => void) | undefined;
  /** The same press's mouse event, in the capture phase. */
  onRootMouseDown?: ((event: ReactMouseEvent<HTMLDivElement>) => void) | undefined;
  /** The host layer, so the launcher can find the mark a launch takes from its row. */
  rootRef?: RefObject<HTMLDivElement | null> | undefined;
  /**
   * Where the launcher shrinks toward as it leaves: the clicked mark, as a
   * `transform-origin` in the launcher block's own box (QL-2, C1).
   */
  departOrigin?: string | undefined;
}

/** The attribute naming a row a launch can take its mark from: `agent:<index>` or `session:<index>`. */
export const LAUNCHER_SOURCE_ATTRIBUTE = 'data-vf-launch-source';

/** The resume glyph at the head of the field: an arrow coming back round. */
function ResumeGlyph() {
  return (
    <svg className="vf-pane-launcher-ico" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4 4v5h5" />
    </svg>
  );
}

function Mark({ providerId }: { providerId?: string | undefined }) {
  return (
    <i className="vf-pane-launcher-mark" aria-hidden="true">
      {providerId ? <AgentIcon providerId={providerId} /> : <span>·</span>}
    </i>
  );
}

function Segments({ segments }: { segments: readonly SnippetSegment[] }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? <mark key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>,
      )}
    </>
  );
}

function Sentence({ sentence }: { sentence: LauncherSentence }) {
  return (
    <p className="vf-pane-launcher-empty">
      {sentence.text}
      <span>{sentence.hint}</span>
    </p>
  );
}

/** A pointer on a row, an agent or the scope switch must not take the keyboard from the field or the terminal. */
function keepFocus(event: { preventDefault(): void }): void {
  event.preventDefault();
}

function idPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** The DOM id of one result row, for `aria-activedescendant`. */
export function launcherOptionId(sessionId: string, index: number): string {
  return `vf-pane-launcher-${idPart(sessionId)}-option-${index}`;
}

function launcherListId(sessionId: string): string {
  return `vf-pane-launcher-${idPart(sessionId)}-list`;
}

const FOOT = (
  <div className="vf-pane-launcher-foot" aria-hidden="true">
    <span>
      <b>↑↓</b> move
    </span>
    <span>
      <b>↵</b> resume here
    </span>
    <span>
      <b>⇥</b> here · all
    </span>
    <span>
      <b>⎋</b> back to the shell
    </span>
  </div>
);

/**
 * The empty pane's launcher as MARKUP, L1 · Ledger (pass 3 §21–§22): a ruled
 * field, the agents as a two-column legend with their keys, and — once the
 * field is open — this folder's sessions, grouped. No card: the block stands on
 * a feathered clearing of the terminal's own ground, every colour mixed from
 * the terminal's ink, the pane colour only on the focus rule, the caret, a
 * matched word and a pressed row (`styles/pane-launcher.css`). Pure over its
 * props, so a host's static tests and catalog can render every state without a
 * pane; `PaneLauncher` is the portal and the state.
 */
export function PaneLauncherChrome({
  sessionId,
  agents,
  folder,
  color,
  active,
  short = false,
  open,
  query,
  scope,
  results,
  highlight,
  history,
  hoverIndex,
  busy,
  failure,
  inputRef,
  onQueryChange,
  onOpen,
  onFieldBlur,
  onLaunch,
  onHover,
  onResume,
  onHighlight,
  onScope,
  onRootPointerDown,
  onRootMouseDown,
  rootRef,
  departOrigin,
}: PaneLauncherChromeProps) {
  const style = { ...(color ? { '--pane-color': color } : {}) } as CSSProperties;
  const leaving = busy?.leaving === true;
  // The pressed row's mark is out with the launch while it leaves and while it comes back.
  const flying = busy !== undefined && (busy.leaving === true || busy.returning === true);
  const className = [
    'vf-pane-launcher',
    open ? 'is-open' : '',
    active ? '' : 'is-resting',
    short ? 'is-short' : '',
    leaving ? 'is-leaving' : '',
    busy ? 'is-busy' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const listId = launcherListId(sessionId);
  const rows = results?.rows ?? [];
  const current = open && highlight >= 0 ? rows[highlight] : undefined;
  const previewIndex = busy?.kind === 'launch' ? busy.index : hoverIndex;
  const previewAgent = active && previewIndex !== undefined ? agents[previewIndex] : undefined;

  let body: ReactNode;
  if (!open) {
    body = active ? (
      <>
        <div className="vf-pane-launcher-cap" aria-hidden="true">
          <span>New</span>
          <span>last used first</span>
        </div>
        <div className="vf-pane-launcher-agents" role="group" aria-label="Launch an agent in this pane">
          {agents.map((agent, index) => {
            const off = agent.unavailable;
            const pressed = busy?.kind === 'launch' && busy.index === index;
            const agentClass = [
              'vf-pane-launcher-agent',
              hoverIndex === index && !off ? 'is-hover' : '',
              pressed ? 'is-press' : '',
              pressed && flying ? 'is-flying' : '',
              off ? 'is-off' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <button
                key={agent.providerId}
                type="button"
                className={agentClass}
                {...{ [LAUNCHER_SOURCE_ATTRIBUTE]: launchSource('launch', index) }}
                title={off ? `${agent.label} · ${off}` : agent.label}
                aria-keyshortcuts={agentKeyShortcut(index)}
                {...(off ? { 'aria-disabled': true } : {})}
                {...(pressed ? { 'aria-busy': true } : {})}
                onPointerDown={keepFocus}
                onClick={() => onLaunch?.(index)}
                onPointerEnter={() => onHover?.(index)}
                onPointerLeave={() => onHover?.(undefined)}
              >
                <Mark providerId={agent.providerId} />
                <span className="vf-pane-launcher-nm">{agent.label}</span>
                {off ? <small>{off}</small> : <kbd>{agentKeyLabel(index)}</kbd>}
              </button>
            );
          })}
        </div>
        <p className="vf-pane-launcher-hint">or just type · this is a shell</p>
      </>
    ) : (
      <></>
    );
  } else if (historyUnavailable(history)) {
    body = <Sentence sentence={historyUnavailableSentence(history as LauncherHistoryStatus)} />;
  } else if (!results) {
    body = (
      <p className="vf-pane-launcher-empty" role="status">
        Reading past sessions…
      </p>
    );
  } else if (rows.length === 0) {
    const statusLine = historyStatusLine(history);
    body = (
      <>
        <Sentence
          sentence={query.trim() === '' ? noSessionsSentence(scope, folder) : noMatchSentence(query, scope, folder)}
        />
        {statusLine ? (
          <div className="vf-pane-launcher-status" role="status">
            <span>{statusLine.text}</span>
          </div>
        ) : null}
      </>
    );
  } else {
    const statusLine = historyStatusLine(history);
    let index = -1;
    body = (
      <>
        <div className="vf-pane-launcher-list" id={listId} role="listbox" aria-label="Past sessions">
          {results.groups.map((group) => {
            const groupId = `${listId}-${group.id}`;
            return (
              <div key={group.id} role="group" aria-labelledby={groupId}>
                <div className="vf-pane-launcher-grp" id={groupId}>
                  {group.label}
                </div>
                {group.rows.map((row) => {
                  index += 1;
                  const rowIndex = index;
                  const selected = rowIndex === highlight;
                  const resuming = busy?.kind === 'resume' && busy.index === rowIndex;
                  const rowClass = [
                    'vf-pane-launcher-row',
                    selected ? 'is-cur' : '',
                    row.session.resumable ? '' : 'is-gone',
                    resuming ? 'is-press' : '',
                    resuming && flying ? 'is-flying' : '',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <div
                      key={row.session.key}
                      id={launcherOptionId(sessionId, rowIndex)}
                      {...{ [LAUNCHER_SOURCE_ATTRIBUTE]: launchSource('resume', rowIndex) }}
                      role="option"
                      aria-selected={selected}
                      {...(row.session.resumable ? {} : { 'aria-disabled': true })}
                      {...(resuming ? { 'aria-busy': true } : {})}
                      className={rowClass}
                      onPointerMove={() => onHighlight?.(rowIndex)}
                      onPointerDown={keepFocus}
                      onClick={() => onResume?.(rowIndex)}
                    >
                      <Mark providerId={row.providerId} />
                      <span className="vf-pane-launcher-rt">
                        <b>
                          <Segments segments={row.titleSegments} />
                        </b>
                        {row.meta ? <small>{row.meta}</small> : null}
                        {row.evidence ? (
                          <small className="vf-pane-launcher-ev">
                            {row.evidence.who}: “<Segments segments={row.evidence.segments} />”
                          </small>
                        ) : null}
                      </span>
                      <kbd aria-hidden="true">{row.session.resumable ? '↵' : ''}</kbd>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {statusLine ? (
          <div
            className="vf-pane-launcher-status"
            role="status"
            {...(statusLine.percent !== undefined
              ? { style: { '--p': `${statusLine.percent}%` } as CSSProperties }
              : {})}
          >
            <span>{statusLine.text}</span>
            {statusLine.percent !== undefined ? <i aria-hidden="true" /> : null}
          </div>
        ) : null}
      </>
    );
  }

  const showFoot = open && !historyUnavailable(history) && rows.length > 0;
  return (
    <div
      ref={rootRef}
      className="vf-pane-launcher-host"
      style={style}
      data-vf-pane-launcher={sessionId}
      onPointerDownCapture={onRootPointerDown}
      onMouseDownCapture={onRootMouseDown}
    >
      {previewAgent ? <span className="vf-pane-launcher-preview">{agentPreview(previewAgent)}</span> : null}
      <div
        className={className}
        role="group"
        aria-label="Resume a session or launch an agent in this pane"
        {...(flying && departOrigin ? { style: { transformOrigin: departOrigin } } : {})}
      >
        <div className={`vf-pane-launcher-field${open ? ' is-focus' : ''}`}>
          <ResumeGlyph />
          <span className="vf-pane-launcher-q">
            <input
              ref={inputRef}
              type="text"
              aria-label="Search past sessions"
              aria-keyshortcuts="Alt+Enter"
              {...(open
                ? {
                    role: 'combobox',
                    'aria-expanded': rows.length > 0,
                    'aria-controls': listId,
                    'aria-autocomplete': 'list' as const,
                    ...(current ? { 'aria-activedescendant': launcherOptionId(sessionId, highlight) } : {}),
                  }
                : { tabIndex: -1 })}
              value={query}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => onQueryChange?.(event.currentTarget.value)}
              onFocus={() => {
                if (!open) onOpen?.();
              }}
              onBlur={onFieldBlur}
            />
            {query === '' ? (
              <span className="vf-pane-launcher-ph" aria-hidden="true">
                {open ? (
                  'Search past sessions'
                ) : (
                  <>
                    <span className="vf-pane-launcher-long">Resume a session…</span>
                    <span className="vf-pane-launcher-short">Resume…</span>
                  </>
                )}
              </span>
            ) : null}
          </span>
          {open ? (
            <span className="vf-pane-launcher-scope" role="group" aria-label="Scope">
              <button
                type="button"
                className={scope === 'here' ? 'is-on' : undefined}
                aria-pressed={scope === 'here'}
                onPointerDown={keepFocus}
                onClick={() => onScope?.('here')}
              >
                here
              </button>
              <button
                type="button"
                className={scope === 'all' ? 'is-on' : undefined}
                aria-pressed={scope === 'all'}
                onPointerDown={keepFocus}
                onClick={() => onScope?.('all')}
              >
                all
              </button>
            </span>
          ) : (
            <kbd className="vf-pane-launcher-k" aria-hidden="true">
              ⌥↵
            </kbd>
          )}
        </div>
        {body}
        {failure ? (
          <p className="vf-pane-launcher-failure" role="alert">
            {failure}
          </p>
        ) : null}
        {showFoot ? FOOT : null}
      </div>
    </div>
  );
}
