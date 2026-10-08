import { memo, useEffect, useRef, useState, type FocusEvent, type ReactElement, type ReactNode } from 'react';
import type { MonitorViewKey, MonitorViewMark } from '@vibecook/puppeteer-view-sdk';
import { keyLegend } from '@vibecook/puppeteer-view-sdk/toolkit';
import type { AgentVisualStatus } from '../monitor/agent-status.js';
import type { MonitorTheme } from '../monitor/types.js';

// The instrument bar (record §04): 40px, no words. Counters on the left where
// the title was, tools on the right, drag space between. Every control is one
// recipe: 22px tall, 5px radius, 9px 700 numerals, 12px marks drawn on a
// 24-unit grid. Tooltips carry the words and the shortcuts. The bar drags the
// window; the controls do not. The one exception to "no words" is the profile
// tabs a host may centre in it (`ProfileTabs`, amended for the tabs 2026-09-22).

/**
 * The host's tools' marks: a 24-unit grid, monoline 1.6, round caps and joins, currentColor. A view's mark is never
 * here: it is the view's own, in its manifest, and the bar draws it filled (`ViewMark`, MV-D6).
 */
const MARKS: Record<string, ReactNode> = {
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

export function Mark({ id, fallback }: { id: string; fallback: string }) {
  const mark = MARKS[id];
  if (!mark) return <span aria-hidden="true">{fallback.slice(0, 1).toUpperCase()}</span>;
  return (
    <svg className="vf-godview-bar-mark" viewBox="0 0 24 24" aria-hidden="true">
      {mark}
    </svg>
  );
}

/**
 * A view's mark, from its manifest (MV-D6): filled paths in currentColor, never stroked (a stroked outline draws both
 * of its edges). A view with no paths shows its label's initial, as an unknown tool does.
 * A manifest is immutable: a host's live counters do not rebuild its mark's path elements.
 */
export const ViewMark = memo(function ViewMark({ mark, fallback }: { mark: MonitorViewMark; fallback: string }) {
  if (mark.paths.length === 0) return <span aria-hidden="true">{fallback.slice(0, 1).toUpperCase()}</span>;
  return (
    <svg className="vf-godview-bar-mark is-filled" viewBox={mark.viewBox} aria-hidden="true">
      {mark.paths.map((path, index) => (
        <path key={index} d={path} />
      ))}
    </svg>
  );
});

const TOOLTIP_DELAY_MS = 600;

export interface TipProps {
  label: string;
  shortcut?: string;
  /** The keys a view takes while it is focused (its manifest's, MV-D8), printed after its name. */
  keys?: readonly MonitorViewKey[];
  /** Hang the tip from the control's right edge, for controls at the bar's end. */
  end?: boolean;
  children: ReactElement;
}

/** The words and the shortcut, raised after 600ms of hover, or at once on keyboard focus. */
export function Tip({ label, shortcut, keys, end, children }: TipProps) {
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
          {keys && keys.length > 0 ? (
            <kbd
              className="vf-godview-bar-keys"
              aria-label={`while focused: ${keys.map((key) => `${key.key}, ${key.label}`).join('; ')}`}
            >
              {keys.map((key) => keyLegend(key.key)).join(' ')}
            </kbd>
          ) : null}
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

/**
 * One tool on the bar: a square control wearing the recipe, with its tip. A
 * host builds its own tools from this — Godview's find, agents, tune and
 * settings; VibeField's spawn — and passes them in the `trailing` slot.
 */
export interface BarControlProps {
  /** The mark to draw (`Mark`), by id; the label's initial when unknown. */
  mark: string;
  label: string;
  shortcut?: string;
  ariaLabel: string;
  on?: boolean;
  disabled?: boolean;
  /** The element this control opens, for `aria-controls` + `aria-expanded`. */
  controls?: string;
  /** Hang the tip from the right edge, for controls at the bar's end. */
  end?: boolean;
  haspopup?: 'dialog' | 'menu' | 'listbox' | 'true';
  onClick(): void;
}

export function BarControl({
  mark,
  label,
  shortcut,
  ariaLabel,
  on,
  disabled,
  controls,
  end,
  haspopup,
  onClick,
}: BarControlProps) {
  return (
    <Tip label={label} {...(shortcut ? { shortcut } : {})} {...(end ? { end } : {})}>
      <button
        type="button"
        className={`vf-godview-bar-control is-square${on ? ' is-on' : ''}`}
        aria-label={ariaLabel}
        {...(controls ? { 'aria-controls': controls, 'aria-expanded': on === true } : {})}
        {...(on !== undefined && !controls ? { 'aria-pressed': on } : {})}
        {...(haspopup ? { 'aria-haspopup': haspopup } : {})}
        disabled={disabled === true}
        onClick={onClick}
      >
        <Mark id={mark} fallback={label} />
      </button>
    </Tip>
  );
}

/** A view as the bar switches to it: its manifest's id, label, mark (MV-D6) and declared keys (MV-D8). */
export interface InstrumentBarView {
  readonly id: string;
  readonly label: string;
  readonly mark: MonitorViewMark;
  readonly keys?: readonly MonitorViewKey[] | undefined;
}

export interface InstrumentBarProps {
  counts: Record<AgentVisualStatus, number>;
  onSelectStatus(status: AgentVisualStatus): void;
  /** Every view the bar switches between: its control draws the manifest's mark and its tip prints the keys. */
  views: readonly InstrumentBarView[];
  viewId: string;
  onSelectView(viewId: string): void;
  theme: MonitorTheme;
  onThemeChange(theme: MonitorTheme): void;
  /** Before the counters: a frameless window's own lights, say. */
  leading?: ReactNode;
  /** Centred between two spacers: the profile tabs (`ProfileTabs`). */
  centre?: ReactNode;
  /** After the view switch, before the theme switch: the host's tools. */
  trailing?: ReactNode;
}

/**
 * The instrument bar (record §04): 40px, no words. Counters on the left, tools
 * on the right, drag space between. Every control is one recipe: 22px tall,
 * 5px radius, 9px 700 numerals, 12px marks drawn on a 24-unit grid. Tooltips
 * carry the words and the shortcuts. Whether the bar drags a window is the
 * host's stylesheet's business, not this component's.
 */
export function InstrumentBar({
  counts,
  onSelectStatus,
  views,
  viewId,
  onSelectView,
  theme,
  onThemeChange,
  leading,
  centre,
  trailing,
}: InstrumentBarProps) {
  const nextTheme: MonitorTheme = theme === 'light' ? 'dark' : 'light';
  return (
    <header className="vf-godview-header">
      {leading}

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

      {centre ? (
        <>
          {centre}
          <div className="vf-godview-bar-spacer" />
        </>
      ) : null}

      <div className="vf-godview-bar-group" role="group" aria-label="Monitor view">
        {views.map((view) => {
          const on = view.id === viewId;
          return (
            <Tip key={view.id} label={view.label} {...(view.keys ? { keys: view.keys } : {})}>
              <button
                type="button"
                className={`vf-godview-bar-control is-square${on ? ' is-on' : ''}`}
                aria-label={`${view.label} view`}
                aria-pressed={on}
                onClick={() => onSelectView(view.id)}
              >
                <ViewMark mark={view.mark} fallback={view.label} />
              </button>
            </Tip>
          );
        })}
      </div>

      {trailing}

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
