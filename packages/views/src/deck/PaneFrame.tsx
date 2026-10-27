import { useEffect, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { AgentIcon } from '@vibefield/puppeteer-view-sdk/react';
import {
  NARROW_PANE_WIDTH,
  paneFrameModel,
  type PaneFrameAgent,
  type PaneFrameModel,
  type PaneFrameSession,
} from './pane-frame.js';

/**
 * The verbs a host lends the frame. Each is optional: a host that cannot stop
 * a turn does not get a stop verb drawn for it, because a button that does
 * nothing is chrome that lies. `stop` sends the agent's own turn stop (the
 * title names its key, `PaneFrameAgent.stopKey`, when it presses one) and
 * answers whether it was DELIVERED (the square goes hollow on the press and
 * solid again on a refusal or when the run leaves `working`); `resume`
 * continues an exited run and the host mounts what comes back where it likes;
 * `zoom` toggles the pane's fullscreen the way the host's own binding would.
 */
export interface PaneFrameVerbs {
  stop?: ((sessionId: string) => Promise<{ accepted: boolean }> | { accepted: boolean } | void) | undefined;
  resume?: ((sessionId: string) => Promise<void> | void) | undefined;
  zoom?: ((pane: HTMLElement) => void) | undefined;
  /** The zoom binding's label for the tooltip, e.g. `⌘⇧↵`; absent = no label. */
  zoomShortcut?: string | undefined;
}

/** How long the square stays hollow after a stop nobody has confirmed. */
export const STOPPING_TIMEOUT_MS = 8_000;

/** The attribute the portal sets on a pane at or under `NARROW_PANE_WIDTH`; the stylesheet and a host's rows select on it. */
export const PANE_NARROW_ATTRIBUTE = 'data-vf-narrow';

/**
 * A pointer on a verb must not take the keyboard from the terminal. Nor does it
 * select the pane: the frame is a portal, and React bubbles a portal's events
 * along the React tree, past Ghosttea's pane and its `onPointerDown`.
 */
export function keepTerminalFocus(event: ReactPointerEvent<HTMLButtonElement>): void {
  event.preventDefault();
}

/** Lobe Icons has no tether; two ends and a line say "elsewhere" until the protocol names the OS. */
function TetherMark() {
  return (
    <svg className="vf-pane-os" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="2.4" cy="6" r="1.7" fill="currentColor" />
      <circle cx="9.6" cy="6" r="1.7" fill="currentColor" />
      <path d="M4.1 6h3.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** The stop verb's title: the turn's time when it has one, then the key the stop presses, if any. */
function stopTitle(verb: { elapsed?: string; key?: string }): string {
  const turn = verb.elapsed ? `Stop the turn, ${verb.elapsed} in` : 'Stop the turn';
  return verb.key ? `${turn} ${verb.key}` : turn;
}

function ZoomMark({ zoomed }: { zoomed: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {zoomed ? (
        <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
      ) : (
        <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
      )}
    </svg>
  );
}

export interface PaneFrameChromeProps {
  /** The session the frame names in `data-vf-pane-frame`, for a host's rows to find. */
  sessionId: string;
  model: PaneFrameModel;
  /** The pane colour the host dealt this pane. */
  color?: string | undefined;
  zoomed: boolean;
  /** A stop was pressed and the run has not left `working` yet. */
  stopping: boolean;
  verbs: PaneFrameVerbs;
  onStop(): void;
  onResume(): void;
  onZoom(): void;
}

/**
 * The chrome around one terminal, as MARKUP: the badge growing out of the top
 * edge, the model · effort readout, the ghost verbs under the pointer, the grey
 * meter along the bottom edge with its figure in the corner. The line and the
 * glow are the frame's own `::before`; the selected pane's radius is CSS on
 * Ghosttea's own pane element (both in `styles/deck-frame.css`). Pure over its
 * props so a host's static tests and
 * catalog can render it without a pane to portal into; `PaneFrame` below is the
 * portal.
 */
export function PaneFrameChrome({
  sessionId,
  model,
  color,
  zoomed,
  stopping,
  verbs,
  onStop,
  onResume,
  onZoom,
}: PaneFrameChromeProps) {
  const style = { ...(color ? { '--pane-color': color } : {}) } as CSSProperties;
  const className = ['vf-pane-frame', model.context?.hot ? 'is-hot' : '', stopping ? 'is-stopping' : '']
    .filter(Boolean)
    .join(' ');
  const showStop = model.verb?.kind === 'stop' && verbs.stop !== undefined;
  const showResume = model.verb?.kind === 'resume' && verbs.resume !== undefined;
  const showZoom = verbs.zoom !== undefined;
  const showVerbs = showStop || showResume || showZoom;
  const zoomLabel = zoomed ? 'Restore' : 'Fullscreen';
  return (
    <div className={className} style={style} data-vf-pane-frame={sessionId}>
      <span className="vf-pane-top">
        {model.readout ? (
          <span
            className="vf-pane-readout"
            title={`${model.readout.model}${model.readout.effort ? ` · ${model.readout.effort}` : ''}`}
          >
            {model.readout.model}
            {model.readout.effort ? (
              <>
                {' · '}
                {model.readout.configured ? <em>{model.readout.effort}</em> : model.readout.effort}
              </>
            ) : null}
          </span>
        ) : null}
        {showVerbs ? (
          <span className="vf-pane-verbs">
            {showResume ? (
              <button
                type="button"
                className="vf-pane-verb is-resume"
                title="Resume this session"
                onPointerDown={keepTerminalFocus}
                onClick={onResume}
              >
                <i aria-hidden="true" />
                <span className="vf-pane-verb-text">resume</span>
              </button>
            ) : null}
            {showStop && model.verb?.kind === 'stop' ? (
              <button
                type="button"
                className="vf-pane-verb is-stop"
                title={stopping ? 'Stopping the turn…' : stopTitle(model.verb)}
                aria-label={stopping ? 'Stopping the turn' : 'Stop the turn'}
                onPointerDown={keepTerminalFocus}
                onClick={onStop}
              >
                <i aria-hidden="true" />
                {model.verb.elapsed ? <span className="vf-pane-verb-text">{model.verb.elapsed}</span> : null}
              </button>
            ) : null}
            {showZoom ? (
              <button
                type="button"
                className="vf-pane-verb is-zoom"
                title={verbs.zoomShortcut ? `${zoomLabel} ${verbs.zoomShortcut}` : zoomLabel}
                aria-label={zoomed ? 'Restore the pane' : 'Fullscreen the pane'}
                onPointerDown={keepTerminalFocus}
                onClick={onZoom}
              >
                <ZoomMark zoomed={zoomed} />
              </button>
            ) : null}
          </span>
        ) : null}
        <span className="vf-pane-badge">
          <span className="vf-pane-badge-name" title={model.remote ? `${model.name} on ${model.remote}` : model.name}>
            {model.remote ? <TetherMark /> : null}
            {model.providerId ? (
              <span className="vf-pane-mark">
                <AgentIcon providerId={model.providerId} />
              </span>
            ) : null}
            <span className="vf-pane-name">{model.name}</span>
          </span>
        </span>
      </span>
      {model.context ? (
        <>
          <i
            className={`vf-pane-meter${model.context.hot ? ' is-hot' : ''}`}
            style={{ '--ctx': model.context.percent / 100 } as CSSProperties}
            aria-hidden="true"
          />
          <span className="vf-pane-bottom">
            <span
              className={`vf-pane-figure${model.context.hot ? ' is-hot' : ''}`}
              title={`Context window ${model.context.percent}% used`}
            >
              {model.context.percent}%
            </span>
          </span>
        </>
      ) : null}
    </div>
  );
}

export interface PaneFrameProps {
  /** Ghosttea's pane element; the frame is portalled into it. */
  pane: HTMLElement;
  session: PaneFrameSession;
  agent?: PaneFrameAgent | undefined;
  /** The device name a remote session lives on; absent for a local session. */
  remote?: string | undefined;
  /** The pane colour the host dealt this pane. */
  color?: string | undefined;
  /** The host's remembered folder for a session with no cwd yet (see `PaneFrameInput`). */
  fallbackCwd?: string | undefined;
  zoomed: boolean;
  nowMs: number;
  verbs: PaneFrameVerbs;
}

/**
 * One frame, portalled into its pane: the model from the host's facts, the
 * stopping state around the host's stop verb, and the narrow tier as an
 * attribute on the pane so its own padding can tighten (the chrome reads the
 * width through container queries).
 */
export function PaneFrame({ pane, session, agent, remote, color, fallbackCwd, zoomed, nowMs, verbs }: PaneFrameProps) {
  const model = paneFrameModel({
    session,
    ...(agent ? { agent } : {}),
    ...(remote ? { remoteDevice: remote } : {}),
    ...(fallbackCwd ? { fallbackCwd } : {}),
    nowMs,
  });
  const status = agent?.status;
  const [stopping, setStopping] = useState(false);

  // The square goes hollow the moment stop is pressed, and solid again when
  // the run leaves `working`; a stop that never lands times out.
  useEffect(() => {
    if (status !== 'working') setStopping(false);
  }, [status]);
  useEffect(() => {
    if (!stopping) return;
    const timer = window.setTimeout(() => setStopping(false), STOPPING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [stopping]);

  // Measured once at mount as well, because an occluded window delivers no
  // resize notifications until it is drawn again.
  useEffect(() => {
    const apply = (width: number): void => {
      pane.toggleAttribute(PANE_NARROW_ATTRIBUTE, width <= NARROW_PANE_WIDTH);
    };
    apply(pane.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) apply(entry.borderBoxSize[0]?.inlineSize ?? pane.getBoundingClientRect().width);
    });
    observer.observe(pane);
    return () => {
      observer.disconnect();
      pane.removeAttribute(PANE_NARROW_ATTRIBUTE);
    };
  }, [pane]);

  // The square goes hollow only while there is a turn to stop. On an idle
  // agent the stop still reaches its TUI, which is why a host sends the
  // agent's own turn stop, the one that never quits it.
  const stop = (): void => {
    if (!verbs.stop || stopping) return;
    if (status === 'working') setStopping(true);
    void Promise.resolve(verbs.stop(session.id)).then((result) => {
      if (result && !result.accepted) setStopping(false);
    });
  };
  const resume = (): void => {
    if (!verbs.resume) return;
    void verbs.resume(session.id);
  };
  const zoom = (): void => {
    verbs.zoom?.(pane);
  };

  return createPortal(
    <PaneFrameChrome
      sessionId={session.id}
      model={model}
      {...(color ? { color } : {})}
      zoomed={zoomed}
      stopping={stopping}
      verbs={verbs}
      onStop={stop}
      onResume={resume}
      onZoom={zoom}
    />,
    pane,
  );
}
