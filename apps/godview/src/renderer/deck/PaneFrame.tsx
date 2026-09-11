import { useEffect, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import { useGhostteaRuntime } from '@vibecook/ghosttea-react';
import { useRemoteSessionLifecycle } from '@vibecook/ghosttea-react/workspace';
import { AgentIcon } from '../AgentIcon.js';
import type { MonitorAgent } from '../monitor/types.js';
import { NARROW_PANE_WIDTH, paneFrameModel, zoomKeyEvent } from './pane-frame.js';

export interface PaneFrameProps {
  /** Ghosttea's pane element; the frame is portalled into it. */
  pane: HTMLElement;
  session: SessionSummary;
  agent?: MonitorAgent;
  /** The pane colour the shell dealt this pane. */
  color?: string;
  zoomed: boolean;
  nowMs: number;
  /** A resumed run's session, to be mounted where the verb was pressed. */
  onResume(session: SessionSummary): void;
}

/** How long the square stays hollow after a stop nobody has confirmed. */
const STOPPING_TIMEOUT_MS = 8_000;

/** A pointer on a verb must not take the keyboard from the terminal; the pane still activates. */
function keepTerminalFocus(event: ReactPointerEvent<HTMLButtonElement>): void {
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

/**
 * The chrome around one terminal: the badge growing out of the top edge, the
 * model · effort readout, the ghost verbs under the pointer, the grey meter
 * along the bottom edge with its figure in the corner. The line, the glow and
 * the selected pane's radius are CSS on Ghosttea's own pane element.
 */
export function PaneFrame({ pane, session, agent, color, zoomed, nowMs, onResume }: PaneFrameProps) {
  const runtime = useGhostteaRuntime();
  const remote = useRemoteSessionLifecycle(session.id);
  const model = paneFrameModel({
    session,
    ...(agent ? { agent } : {}),
    ...(remote ? { remoteDevice: remote.deviceName } : {}),
    nowMs,
  });
  const runtimeSessionId = agent?.agent?.info.runtimeSessionId;
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

  // The narrow tier is an attribute on the pane, so its own padding can
  // tighten; the frame's chrome reads the width through container queries.
  // Measured once at mount as well, because an occluded window delivers no
  // resize notifications until it is drawn again.
  useEffect(() => {
    const apply = (width: number): void => {
      pane.toggleAttribute('data-vf-narrow', width <= NARROW_PANE_WIDTH);
    };
    apply(pane.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) apply(entry.borderBoxSize[0]?.inlineSize ?? pane.getBoundingClientRect().width);
    });
    observer.observe(pane);
    return () => {
      observer.disconnect();
      pane.removeAttribute('data-vf-narrow');
    };
  }, [pane]);

  // The square goes hollow only while there is a turn to stop; on an idle
  // agent the interrupt still reaches its TUI, as ^C would.
  const stop = (): void => {
    if (!runtimeSessionId || stopping) return;
    if (status === 'working') setStopping(true);
    void window.puppeteer.interruptAgent(runtimeSessionId).then((result) => {
      if (!result.accepted) setStopping(false);
    });
  };
  const resume = (): void => {
    if (!runtimeSessionId) return;
    void window.puppeteer.resumeAgentSession(runtimeSessionId).then((result) => {
      if ('error' in result) console.warn(`[deck] could not resume: ${result.error.message}`);
      else onResume(result.session);
    });
  };
  const zoom = (): void => {
    const key = zoomKeyEvent(runtime.configSnapshot?.workspace, window.desktop.platform);
    if (!key) return;
    pane.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: key.key,
        ...(key.code ? { code: key.code } : {}),
        metaKey: key.metaKey,
        ctrlKey: key.ctrlKey,
        altKey: key.altKey,
        shiftKey: key.shiftKey,
        bubbles: true,
        cancelable: true,
      }),
    );
  };

  const zoomShortcut = window.desktop.platform === 'darwin' ? '⌘⇧↵' : '⌃⇧↵';
  const style = { ...(color ? { '--pane-color': color } : {}) } as CSSProperties;
  const className = ['vf-pane-frame', model.context?.hot ? 'is-hot' : '', stopping ? 'is-stopping' : '']
    .filter(Boolean)
    .join(' ');

  return createPortal(
    <div className={className} style={style} data-vf-pane-frame={session.id}>
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
        {model.verb ? (
          <span className="vf-pane-verbs">
            {model.verb.kind === 'resume' ? (
              <button
                type="button"
                className="vf-pane-verb is-resume"
                title="Resume this session"
                onPointerDown={keepTerminalFocus}
                onClick={resume}
              >
                <i aria-hidden="true" />
                <span className="vf-pane-verb-text">resume</span>
              </button>
            ) : (
              <button
                type="button"
                className="vf-pane-verb is-stop"
                title={
                  stopping
                    ? 'Stopping the turn…'
                    : model.verb.elapsed
                      ? `Stop the turn, ${model.verb.elapsed} in ⌃C`
                      : 'Stop the turn ⌃C'
                }
                aria-label={stopping ? 'Stopping the turn' : 'Stop the turn'}
                onPointerDown={keepTerminalFocus}
                onClick={stop}
              >
                <i aria-hidden="true" />
                {model.verb.elapsed ? <span className="vf-pane-verb-text">{model.verb.elapsed}</span> : null}
              </button>
            )}
            <button
              type="button"
              className="vf-pane-verb is-zoom"
              title={`${zoomed ? 'Restore' : 'Fullscreen'} ${zoomShortcut}`}
              aria-label={zoomed ? 'Restore the pane' : 'Fullscreen the pane'}
              onPointerDown={keepTerminalFocus}
              onClick={zoom}
            >
              <ZoomMark zoomed={zoomed} />
            </button>
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
    </div>,
    pane,
  );
}
