import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
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
 * Optional host controls. A session stop ends the agent; pause cancels only
 * the current turn. Older hosts can still lend a turn stop. Acceptance means
 * delivery, not an observed exit or idle state. Resume continues an exited
 * run; zoom uses the host's pane controller.
 */
export interface PaneFrameVerbs {
  stop?: ((sessionId: string) => Promise<{ accepted: boolean }> | { accepted: boolean } | void) | undefined;
  /** A session stop ends the agent, including when idle; turn cancellation
   * remains the default for hosts that lend an interrupt control. */
  stopKind?: 'turn' | 'session' | undefined;
  pause?: ((sessionId: string) => Promise<{ accepted: boolean }> | { accepted: boolean } | void) | undefined;
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
function stopTitle(verb: { elapsed?: string; key?: string }, label = 'Stop the turn'): string {
  const turn = verb.elapsed ? `${label}, ${verb.elapsed} in` : label;
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
  /** The host has not yet observed the requested stop. */
  stopping: boolean;
  pausing?: boolean | undefined;
  verbs: PaneFrameVerbs;
  onStop(): void;
  onPause?: (() => void) | undefined;
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
  pausing = false,
  verbs,
  onStop,
  onPause,
  onResume,
  onZoom,
}: PaneFrameChromeProps) {
  const stoppingWord = verbs.stopKind === 'session' ? 'Stopping agent' : 'Stopping the turn';
  const style = { ...(color ? { '--pane-color': color } : {}) } as CSSProperties;
  const className = [
    'vf-pane-frame',
    model.context?.hot ? 'is-hot' : '',
    stopping ? 'is-stopping' : '',
    pausing ? 'is-pausing' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const showStop = model.verb?.kind === 'stop' && verbs.stop !== undefined;
  const showPause = model.verb?.kind === 'stop' && verbs.pause !== undefined;
  const showResume = model.verb?.kind === 'resume' && verbs.resume !== undefined;
  const showZoom = verbs.zoom !== undefined;
  const showVerbs = showStop || showPause || showResume || showZoom;
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
            {showPause && model.verb?.kind === 'stop' ? (
              <button
                type="button"
                className="vf-pane-verb is-pause"
                title={pausing ? 'Pausing current turn…' : stopTitle(model.verb, 'Pause current turn')}
                aria-label={pausing ? 'Pausing current turn' : 'Pause current turn'}
                disabled={!model.turnActive || pausing || stopping}
                onPointerDown={keepTerminalFocus}
                onClick={onPause}
              >
                <i aria-hidden="true" />
                {model.verb.elapsed ? <span className="vf-pane-verb-text">{model.verb.elapsed}</span> : null}
              </button>
            ) : null}
            {showStop && model.verb?.kind === 'stop' ? (
              <button
                type="button"
                className="vf-pane-verb is-stop"
                title={
                  stopping ? `${stoppingWord}…` : verbs.stopKind === 'session' ? 'Stop agent' : stopTitle(model.verb)
                }
                aria-label={stopping ? stoppingWord : verbs.stopKind === 'session' ? 'Stop agent' : 'Stop the turn'}
                disabled={stopping}
                onPointerDown={keepTerminalFocus}
                onClick={onStop}
              >
                <i aria-hidden="true" />
                {verbs.stopKind !== 'session' && model.verb.elapsed ? (
                  <span className="vf-pane-verb-text">{model.verb.elapsed}</span>
                ) : null}
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
  const endsSession = verbs.stopKind === 'session';
  const [stopping, setStopping] = useState(false);
  const [pausing, setPausing] = useState(false);
  const control = useRef({ sessionId: session.id, stop: false, pause: false });
  if (control.current.sessionId !== session.id) control.current = { sessionId: session.id, stop: false, pause: false };
  useEffect(() => {
    setStopping(false);
    setPausing(false);
  }, [session.id]);

  // Session termination stays pending even when the turn becomes idle.
  useEffect(() => {
    if (endsSession ? session.exited || agent?.alive === false : status !== 'working') setStopping(false);
  }, [status, endsSession, session.exited, agent?.alive]);
  useEffect(() => {
    if (!stopping) return;
    const timer = window.setTimeout(() => setStopping(false), STOPPING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [stopping]);
  useEffect(() => {
    if (status !== 'working' || session.exited || agent?.alive === false) setPausing(false);
  }, [status, session.exited, agent?.alive]);
  useEffect(() => {
    if (!pausing) return;
    const timer = window.setTimeout(() => setPausing(false), STOPPING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [pausing]);

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

  // Fence synchronous repeated presses and late replies after a pane changes
  // sessions. The host coalesces requests from mirrored panes as well.
  const stop = (): void => {
    if (!verbs.stop || stopping || control.current.stop) return;
    const request = control.current;
    request.stop = true;
    if (endsSession) setPausing(false);
    if (endsSession || status === 'working') setStopping(true);
    void Promise.resolve()
      .then(() => verbs.stop?.(session.id))
      .then(
        (result) => {
          if (control.current === request && result && !result.accepted) setStopping(false);
        },
        () => {
          if (control.current === request) setStopping(false);
        },
      )
      .finally(() => {
        request.stop = false;
      });
  };
  const pause = (): void => {
    if (!verbs.pause || !model.turnActive || stopping || pausing || control.current.stop || control.current.pause)
      return;
    const request = control.current;
    request.pause = true;
    setPausing(true);
    void Promise.resolve()
      .then(() => verbs.pause?.(session.id))
      .then(
        (result) => {
          if (control.current === request && result && !result.accepted) setPausing(false);
        },
        () => {
          if (control.current === request) setPausing(false);
        },
      )
      .finally(() => {
        request.pause = false;
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
      pausing={pausing}
      verbs={verbs}
      onStop={stop}
      onPause={pause}
      onResume={resume}
      onZoom={zoom}
    />,
    pane,
  );
}
