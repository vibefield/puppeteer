/**
 * The launch's model (QL-2, Minimal Pane Frame pass 4 §27, look C · Cells):
 * everything the launch decides without a DOM. A launch is held per PANE
 * from the click to the agent's first frame; three facts move it (the click,
 * the port's answer, the first frame) and nothing else does — save the born
 * session leaving its pane before it drew, which ends it. `PaneLaunch.tsx`
 * draws it and `DeckLaunchers.tsx` feeds it the facts.
 */

/** C5: the indicator appears this long after the click; a launch drawn by then shows none. */
export const LAUNCH_INDICATOR_MS = 320;
/** C4: the caption adds the seconds from here on. */
export const LAUNCH_FIGURE_MS = 1_500;
/** C9: a first frame that has not come this long after the port's answer releases the pane anyway. */
export const LAUNCH_LATE_FRAME_MS = 3_000;

/** The launcher shrinks away toward the clicked mark (the island easing). */
export const LAUNCH_DEPART_MS = 160;
/** The mark hops from its row to the middle of the pane (the pop spring: a spawn pop-in). */
export const LAUNCH_HOP_MS = 400;
/** The cell grid wakes, or reaches the corners, or drains (the island easing). */
export const LAUNCH_REACH_MS = 560;
/** One ripple, from the mark out to the grid's reach. */
export const LAUNCH_RIPPLE_MS = 1_100;
/** The last ripple: the ground opens from the mark outward and the terminal is behind it. */
export const LAUNCH_REVEAL_MS = 480;
/** The mark leaves for the badge this long after the reveal starts. */
export const LAUNCH_HOME_DELAY_MS = 140;
/** The mark's flight to the badge's slot. */
export const LAUNCH_HOME_MS = 420;
/** The badge's slot opens for the arriving mark. */
export const LAUNCH_SLOT_MS = 240;
/** A refusal: the grid drains into the mark, then the ground lifts and the mark hops back to its row. */
export const LAUNCH_DRAIN_MS = 240;
export const LAUNCH_RETURN_MS = 360;
/** An agent that left before it drew: after the drain, the mark goes out where it is. */
export const LAUNCH_GONE_MS = 160;
/** The mark follows the pane's middle when the pane is resized under it. */
export const LAUNCH_RECENTRE_MS = 240;

/** The mark at the middle, and the patch of grid woken around it while the agent starts. */
export const LAUNCH_MARK_SIZE = 26;
export const LAUNCH_PATCH_RADIUS = 100;
/** Where "the middle" is: half way across, 46% down (the optical centre under the frame's top band). */
export const LAUNCH_CENTRE_Y = 0.46;

/**
 * Where a launch is. `depart`: the launcher is leaving and the mark is on its
 * way to the middle, no indicator yet. `starting` and `opening`: the indicator,
 * before and after the port's answer. `home`: the first frame (or C9's release)
 * came and the mark is going to the badge. `refused`: the port said no and the
 * mark is going back to its row. `left`: the agent's session left the pane
 * before it drew (it exited at once), so the launch lets the pane go.
 */
export type LaunchPhase = 'depart' | 'starting' | 'opening' | 'home' | 'refused' | 'left';

/** What a launch was asked to do: a new agent, or a past session. */
export type LaunchVerb = 'launch' | 'resume';

export interface LaunchState {
  phase: LaunchPhase;
  /** The port answered yes: the run exists and its terminal is in this pane. */
  running: boolean;
  /** Reached `home` before the indicator appeared: no indicator is ever shown (C5). */
  fast: boolean;
  /** The born session, when the host named it. */
  sessionId?: string | undefined;
  /** Why a refused launch was refused, in the host's words. */
  reason?: string | undefined;
}

export type LaunchEvent =
  /** `LAUNCH_INDICATOR_MS` after the click. */
  | { type: 'indicator' }
  /** The port answered yes. */
  | { type: 'running'; sessionId?: string | undefined }
  /** The agent's terminal drew its first frame (or the host has no way to know, at `running`). */
  | { type: 'drawn' }
  /** `LAUNCH_LATE_FRAME_MS` after `running`, with no first frame (C9). */
  | { type: 'late' }
  /** The port answered no. */
  | { type: 'refused'; reason: string }
  /** The born session left the pane before its first frame: the pane shows another session now. */
  | { type: 'left' };

export function initialLaunch(): LaunchState {
  return { phase: 'depart', running: false, fast: false };
}

/** Whether the launch has settled on a way out (home, back, or gone): no fact moves it any more. */
export function launchSettled(state: LaunchState): boolean {
  return state.phase === 'home' || state.phase === 'refused' || state.phase === 'left';
}

/** Whether the indicator (the grid, the ripples, the caption) is up. */
export function launchWaiting(phase: LaunchPhase): boolean {
  return phase === 'starting' || phase === 'opening';
}

/**
 * One fact, applied. The launch only moves forward: a settled launch ignores
 * every later fact, a fact that arrives twice is the first one, and a first
 * frame can only follow the port's answer.
 */
export function reduceLaunch(state: LaunchState, event: LaunchEvent): LaunchState {
  if (launchSettled(state)) return state;
  switch (event.type) {
    case 'indicator':
      if (state.phase !== 'depart') return state;
      return { ...state, phase: state.running ? 'opening' : 'starting' };
    case 'running': {
      if (state.running) return state;
      const next: LaunchState = {
        ...state,
        running: true,
        ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
      };
      return state.phase === 'starting' ? { ...next, phase: 'opening' } : next;
    }
    case 'drawn':
    case 'late':
      if (!state.running) return state;
      return { ...state, phase: 'home', fast: state.phase === 'depart' };
    case 'refused':
      return { ...state, phase: 'refused', reason: event.reason };
    case 'left':
      // Only a session the port named can leave; before the answer the pane's
      // session is the host's business (it may mount the agent first).
      if (!state.running || state.sessionId === undefined) return state;
      return { ...state, phase: 'left' };
    default:
      return state;
  }
}

/** The seconds as the caption says them: tenths under ten seconds, whole seconds after. */
export function formatLaunchSeconds(elapsedMs: number): string {
  const ms = Math.max(0, elapsedMs);
  return ms < 10_000 ? `${(ms / 1_000).toFixed(1)}s` : `${Math.floor(ms / 1_000)}s`;
}

/**
 * The caption's second line (C4): which wait, then from `LAUNCH_FIGURE_MS` the
 * seconds since the click. A resume says `resuming` where a launch says
 * `starting`; both say `opening` once the agent runs.
 */
export function launchCaption(verb: LaunchVerb, phase: LaunchPhase, elapsedMs: number): string {
  const word = phase === 'opening' ? 'opening' : verb === 'resume' ? 'resuming' : 'starting';
  return elapsedMs >= LAUNCH_FIGURE_MS ? `${word} · ${formatLaunchSeconds(elapsedMs)}` : word;
}

/**
 * What a screen reader hears: nothing while the launch departs (a live region
 * that is filled as it mounts is not reliably read, and a launch drawn inside
 * `LAUNCH_INDICATOR_MS` only needs its arrival said), then the wait once the
 * indicator is up, then how it ended.
 */
export function launchAnnouncement(verb: LaunchVerb, label: string, phase: LaunchPhase): string {
  if (phase === 'depart') return '';
  if (phase === 'refused') return `${label} did not ${verb === 'resume' ? 'resume' : 'launch'}`;
  if (phase === 'left') return `${label} exited before it opened`;
  if (phase === 'home') return `${label} is open`;
  return `${verb === 'resume' ? 'Resuming' : 'Starting'} ${label}`;
}

/**
 * The row a launch took its mark from, as the launcher names it
 * (`data-vf-launch-source`): an agent's row for a launch, a result's for a resume.
 */
export function launchSource(verb: LaunchVerb, index: number): string {
  return `${verb === 'resume' ? 'session' : 'agent'}:${index}`;
}

export interface LaunchPoint {
  x: number;
  y: number;
}

/** A box in the pane's own pixels: the clicked mark at the click, the badge's slot on arrival. */
export interface LaunchRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The middle of a pane, in the pane's own pixels. */
export function launchCentre(width: number, height: number): LaunchPoint {
  return { x: Math.round(width / 2), y: Math.round(height * LAUNCH_CENTRE_Y) };
}

/** How far the grid reaches once the agent runs: the farthest corner, and a little past it. */
export function launchReach(width: number, height: number, centre: LaunchPoint = launchCentre(width, height)): number {
  return Math.ceil(Math.hypot(Math.max(centre.x, width - centre.x), Math.max(centre.y, height - centre.y))) + 12;
}

/**
 * How a host tells a launch that a born session has drawn its first frame:
 * call `onDrawn` once it has (at once if it already has) and return the way to
 * stop watching (C3).
 */
export type WatchFirstFrame = (sessionId: string, onDrawn: () => void) => (() => void) | void;

/**
 * A runtime that publishes drawn sessions the way Ghosttea does from 0.12
 * (`sessionHasDrawn` and a `session-drawn` event whose `detail.sessionId` names
 * the session). The method is optional so an older runtime still type-checks.
 */
export interface DrawnSessionSource {
  sessionHasDrawn?: ((sessionId: string) => boolean) | undefined;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/**
 * `watchFirstFrame` over such a runtime; `undefined` for one without the
 * signal, so a launch lands at the port's answer instead of waiting on
 * something that will never come.
 */
export function watchDrawnSessions(source: DrawnSessionSource): WatchFirstFrame | undefined {
  const hasDrawn = source.sessionHasDrawn;
  if (typeof hasDrawn !== 'function') return undefined;
  return (sessionId, onDrawn) => {
    if (hasDrawn.call(source, sessionId)) {
      onDrawn();
      return undefined;
    }
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<{ sessionId?: unknown } | undefined>).detail;
      if (detail?.sessionId !== sessionId) return;
      source.removeEventListener('session-drawn', listener);
      onDrawn();
    };
    source.addEventListener('session-drawn', listener);
    return () => source.removeEventListener('session-drawn', listener);
  };
}

/** Durations under reduced motion (M6): half, and nothing that travels. */
export function launchDuration(ms: number, reduced: boolean): number {
  return reduced ? Math.round(ms / 2) : ms;
}
