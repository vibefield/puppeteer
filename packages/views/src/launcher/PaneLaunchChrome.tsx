import type { CSSProperties, RefObject } from 'react';
import { AgentIcon } from '../icons/AgentIcon.js';
import {
  LAUNCH_MARK_SIZE,
  launchAnnouncement,
  type LaunchPhase,
  type LaunchPoint,
  type LaunchVerb,
} from './launch-model.js';

export interface PaneLaunchChromeProps {
  /** Names the launch in `data-vf-pane-launch`, for a host's rows and smokes to find. */
  launchId: string;
  verb: LaunchVerb;
  /** The agent's mark; absent for a past session whose agent the host could not name. */
  providerId?: string | undefined;
  /** The agent, as the launcher's row named it. */
  label: string;
  phase: LaunchPhase;
  /** The caption's second line (`launchCaption`), as the mounter's clock says it. */
  caption: string;
  /** The pane colour the host dealt this pane. */
  color?: string | undefined;
  /** The middle of the pane, in its own pixels (`launchCentre`): the grid's, the ripple's and the caption's. */
  centre: LaunchPoint;
  /**
   * Where the mark is drawn at mount, `centre` by default. The live portal pins
   * it to the mount's centre and moves the mark itself from then on, so a resize
   * never has React rewrite the transform of a mark in flight.
   */
  markAt?: LaunchPoint | undefined;
  /** How far the grid reaches: the patch while the agent starts, past the corners once it runs. */
  reach: number;
  /** The terminal's ground covers the pane (the launch's own; the reveal opens it). */
  lit: boolean;
  /** The indicator is up: the ripple, the caption and the mark's breath. */
  waiting: boolean;
  /** Reduced motion (M6), when the mounter decided it rather than the media query. */
  reduced?: boolean | undefined;
  /** The portal's handles for its choreography; a static host passes none. */
  markRef?: RefObject<HTMLElement | null> | undefined;
  groundRef?: RefObject<HTMLDivElement | null> | undefined;
  gridRef?: RefObject<HTMLDivElement | null> | undefined;
  captionRef?: RefObject<HTMLSpanElement | null> | undefined;
}

/**
 * The launch as MARKUP, look C · Cells (Minimal Pane Frame pass 4 §30): the
 * terminal's ground over the pane, the pane's own cell grid as dots under it
 * (one per terminal cell, masked to the grid's reach), a band of the pane
 * colour rippling out through the cells, the caption under the mark, and the
 * mark. Every colour is mixed from the terminal's ink and the pane colour
 * (`styles/pane-launcher.css`, "the launch"). Pure over its props, so a host's
 * static tests and catalog can render any face of it without a pane;
 * `PaneLaunch` is the portal and the choreography.
 */
export function PaneLaunchChrome({
  launchId,
  verb,
  providerId,
  label,
  phase,
  caption,
  color,
  centre,
  markAt = centre,
  reach,
  lit,
  waiting,
  reduced,
  markRef,
  groundRef,
  gridRef,
  captionRef,
}: PaneLaunchChromeProps) {
  const style = {
    '--launch-cx': `${centre.x}px`,
    '--launch-cy': `${centre.y}px`,
    ...(color ? { '--pane-color': color } : {}),
  } as CSSProperties;
  const className = [
    'vf-pane-launch',
    `is-${phase}`,
    lit ? 'is-lit' : '',
    waiting ? 'is-waiting' : '',
    reduced ? 'is-reduced' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const half = LAUNCH_MARK_SIZE / 2;
  return (
    <div className={className} style={style} data-vf-pane-launch={launchId}>
      <div className="vf-pane-launch-ground" ref={groundRef} aria-hidden="true">
        <div className="vf-pane-launch-grid" ref={gridRef} style={{ '--vf-launch-r': `${reach}px` } as CSSProperties} />
        <div
          className="vf-pane-launch-ripple"
          style={{ '--launch-ripple-max': `${Math.max(40, reach)}px` } as CSSProperties}
        />
      </div>
      <div className="vf-pane-launch-caption" aria-hidden="true">
        <b>{label}</b>
        <span ref={captionRef}>{caption}</span>
      </div>
      <i
        className="vf-pane-launch-mark"
        ref={markRef}
        aria-hidden="true"
        style={{ transform: `translate(${markAt.x - half}px, ${markAt.y - half}px)` }}
      >
        <span className="vf-pane-launch-glyph">{providerId ? <AgentIcon providerId={providerId} /> : '·'}</span>
      </i>
      <span className="vf-pane-launch-sr" role="status" aria-live="polite">
        {launchAnnouncement(verb, label, phase)}
      </span>
    </div>
  );
}
