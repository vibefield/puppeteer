import { useEffect, useRef, useState, type FocusEvent, type ReactElement, type ReactNode } from 'react';
import type { GodviewTheme } from '../appearance-themes.js';
import type { AgentVisualStatus } from './agent-status.js';
import type { WorkspaceSettings } from './deck/workspace-settings.js';
import type { AgentMonitorView } from './monitor/types.js';

// The instrument bar (record §04): 40px, no words. Counters on the left where
// the title was, tools on the right, drag space between. Every control is one
// recipe: 22px tall, 5px radius, 9px 700 numerals, 12px marks drawn on a
// 24-unit grid. Tooltips carry the words and the shortcuts. The bar drags the
// window; the controls do not.

/** The marks: a 24-unit grid, monoline 1.6, round caps and joins, currentColor. */
const MARKS: Record<string, ReactNode> = {
  // Three bodies.
  swarm: (
    <>
      <circle cx="7.5" cy="8" r="3" />
      <circle cx="16" cy="6.5" r="2.2" />
      <circle cx="13" cy="16" r="4.2" />
    </>
  ),
  // Three rules.
  list: <path d="M5 7h14M5 12h14M5 17h14" />,
  // Three broken columns.
  rain: <path d="M7 4v5M7 12.5v2.5M12 3v2.5M12 8.5v8M17 5v3.5M17 12v6" />,
  // Two sliders.
  tune: (
    <>
      <path d="M4 8h3M11.2 8H20M4 16h9.2M17.4 16H20" />
      <circle cx="9.1" cy="8" r="2.1" />
      <circle cx="15.3" cy="16" r="2.1" />
    </>
  ),
  // A glass over what was said.
  find: (
    <>
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="M14.6 14.6L20 20" />
    </>
  ),
  // The crate: the installed agents and their accounts.
  agents: <path d="M4 9.5h16V20H4zM4 9.5l2.2-4.5h11.6L20 9.5M10 13.5h4" />,
  settings: (
    <>
      <path
        d="m9 3-.5 2.5-2 1.2L4 6l-3 5 2 1.7V15l-2 1.7 3 5 2.5-.7 2 1.2L9 25h6l.5-2.8 2-1.2 2.5.7 3-5-2-1.7v-2.3l2-1.7-3-5-2.5.7-2-1.2L15 3Z"
        transform="translate(2 0) scale(.83)"
      />
      <circle cx="12" cy="11.6" r="3" />
    </>
  ),
};

function Mark({ id, fallback }: { id: string; fallback: string }) {
  const mark = MARKS[id];
  if (!mark) return <span aria-hidden="true">{fallback.slice(0, 1).toUpperCase()}</span>;
  return (
    <svg className="vf-godview-bar-mark" viewBox="0 0 24 24" aria-hidden="true">
      {mark}
    </svg>
  );
}

const TOOLTIP_DELAY_MS = 600;

interface TipProps {
  label: string;
  shortcut?: string;
  /** Hang the tip from the control's right edge, for controls at the bar's end. */
  end?: boolean;
  children: ReactElement;
}

/** The words and the shortcut, raised after 600ms of hover, or at once on keyboard focus. */
function Tip({ label, shortcut, end, children }: TipProps) {
  const [shown, setShown] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const clear = (): void => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  useEffect(() => clear, []);
  const raise = (): void => {
    clear();
    timer.current = window.setTimeout(() => setShown(true), TOOLTIP_DELAY_MS);
  };
  const drop = (): void => {
    clear();
    setShown(false);
  };
  const onFocus = (event: FocusEvent<HTMLSpanElement>): void => {
    if (event.target.matches(':focus-visible')) setShown(true);
  };
  return (
    <span
      className="vf-godview-bar-tip-host"
      onPointerEnter={raise}
      onPointerLeave={drop}
      onPointerDown={drop}
      onFocus={onFocus}
      onBlur={drop}
    >
      {children}
      {shown ? (
        <span className={`vf-godview-bar-tip${end ? ' is-end' : ''}`} role="tooltip">
          {label}
          {shortcut ? <kbd>{shortcut}</kbd> : null}
        </span>
      ) : null}
    </span>
  );
}

const COUNTERS: readonly { status: AgentVisualStatus; label: string; shortcut: string }[] = [
  { status: 'blocked', label: 'BLOCKED', shortcut: '⌘1' },
  { status: 'working', label: 'WORKING', shortcut: '⌘2' },
  { status: 'idle', label: 'IDLE', shortcut: '⌘3' },
];

export interface InstrumentBarProps {
  counts: Record<AgentVisualStatus, number>;
  onSelectStatus(status: AgentVisualStatus): void;
  views: readonly AgentMonitorView[];
  viewId: string;
  onSelectView(viewId: string): void;
  findOpen: boolean;
  onToggleFind(): void;
  agentsOpen: boolean;
  onToggleAgents(): void;
  tuneOpen: boolean;
  onToggleTune(): void;
  settings: WorkspaceSettings | undefined;
  theme: GodviewTheme;
  onThemeChange(theme: GodviewTheme): void;
}

export function InstrumentBar({
  counts,
  onSelectStatus,
  views,
  viewId,
  onSelectView,
  findOpen,
  onToggleFind,
  agentsOpen,
  onToggleAgents,
  tuneOpen,
  onToggleTune,
  settings,
  theme,
  onThemeChange,
}: InstrumentBarProps) {
  const nextTheme: GodviewTheme = theme === 'light' ? 'dark' : 'light';
  return (
    <header className="vf-godview-header">
      <div className="vf-godview-window-controls" aria-hidden="true">
        <i className="is-close" />
        <i className="is-minimize" />
        <i className="is-expand" />
      </div>

      <div className="vf-godview-bar-group" role="group" aria-label="Agent status">
        {COUNTERS.map(({ status, label, shortcut }) => (
          <Tip key={status} label={`${label} · ${counts[status]}`} shortcut={shortcut}>
            <button
              type="button"
              className="vf-godview-bar-control"
              aria-label={`${label}, ${counts[status]}, cycle with command ${shortcut.slice(1)}`}
              onClick={() => onSelectStatus(status)}
            >
              <i className={`vf-godview-bar-dot is-${status}`} />
              <b className="vf-godview-bar-num">{counts[status]}</b>
            </button>
          </Tip>
        ))}
      </div>

      <div className="vf-godview-bar-spacer" />

      <div className="vf-godview-bar-group" role="group" aria-label="Monitor view">
        {views.map((view) => {
          const on = view.id === viewId;
          return (
            <Tip key={view.id} label={view.label}>
              <button
                type="button"
                className={`vf-godview-bar-control is-square${on ? ' is-on' : ''}`}
                aria-label={`${view.label} view`}
                aria-pressed={on}
                onClick={() => onSelectView(view.id)}
              >
                <Mark id={view.id} fallback={view.label} />
              </button>
            </Tip>
          );
        })}
      </div>

      <Tip label="FIND" shortcut="⌘F">
        <button
          type="button"
          className={`vf-godview-bar-control is-square${findOpen ? ' is-on' : ''}`}
          aria-label="Find an agent by what was said"
          aria-controls="vf-find-sheet"
          aria-expanded={findOpen}
          onClick={onToggleFind}
        >
          <Mark id="find" fallback="F" />
        </button>
      </Tip>

      <Tip label="AGENTS">
        <button
          type="button"
          className={`vf-godview-bar-control is-square${agentsOpen ? ' is-on' : ''}`}
          aria-label="Installed agents and accounts"
          aria-controls="vf-agents-drawer"
          aria-expanded={agentsOpen}
          onClick={onToggleAgents}
        >
          <Mark id="agents" fallback="A" />
        </button>
      </Tip>

      <Tip label="SYSTEM CONTROL">
        <button
          type="button"
          className={`vf-godview-bar-control is-square${tuneOpen ? ' is-on' : ''}`}
          aria-label="System control"
          aria-controls="vf-godview-tweak-panel"
          aria-expanded={tuneOpen}
          onClick={onToggleTune}
        >
          <Mark id="tune" fallback="T" />
        </button>
      </Tip>

      {settings ? (
        <Tip label="SETTINGS" end>
          <button
            type="button"
            className="vf-godview-bar-control is-square"
            aria-label="Open settings"
            aria-haspopup="dialog"
            disabled={!settings.enabled}
            onClick={settings.open}
          >
            <Mark id="settings" fallback="S" />
          </button>
        </Tip>
      ) : null}

      <Tip label={`SWITCH TO ${nextTheme.toUpperCase()}`} end>
        <button
          className="vf-godview-theme-switch"
          type="button"
          role="switch"
          aria-checked={theme === 'dark'}
          aria-label={`Switch to ${nextTheme} theme`}
          onClick={() => onThemeChange(nextTheme)}
        >
          <span aria-hidden="true">☼</span>
          <span className="vf-godview-theme-switch-track" aria-hidden="true">
            <i />
          </span>
          <span aria-hidden="true">◐</span>
        </button>
      </Tip>
    </header>
  );
}
