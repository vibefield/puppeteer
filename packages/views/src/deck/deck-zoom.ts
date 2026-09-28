/** Animate the pane frame while keeping terminal pixels and PTY geometry fixed.
 * The content box changes once, at settlement; no canvas is cloned or remounted. */
export type DeckZoomPhase = 'idle' | 'entering' | 'zoomed' | 'leaving';
export interface ZoomRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
export const ZOOM_DURATION_MS = 240;
export const ZOOM_REDUCED_DURATION_MS = 120;
export const ZOOM_COMMIT_GRACE_MS = 60;
export interface DeckZoomState {
  readonly phase: DeckZoomPhase;
  readonly paneId: string | null;
  readonly commits: number;
}
export interface DeckZoomHost {
  host(): HTMLElement | null;
  pane(id: string): HTMLElement | null;
  stage(): HTMLElement | null;
  measure(element: HTMLElement): ZoomRect;
  reducedMotion(): boolean;
  raf(callback: () => void): number;
  cancelRaf(handle: number): void;
  timeout(callback: () => void, ms: number): number;
  cancelTimeout(handle: number): void;
}
export function zoomLayoutApplied(phase: DeckZoomPhase): boolean {
  return phase !== 'idle';
}
const MARKER = 'data-vf-zoom-pane';
const PROPERTIES = ['left', 'top', 'width', 'height'];

export class DeckZoomController {
  readonly #host: DeckZoomHost;
  readonly #notify: (state: DeckZoomState) => void;
  #phase: DeckZoomPhase = 'idle';
  #paneId: string | null = null;
  #commits = 0;
  #pane: HTMLElement | null = null;
  #anchor: HTMLElement | null = null;
  #home: ZoomRect | null = null;
  #raf: number | undefined;
  #timer: number | undefined;
  #onEnd: ((event: Event) => void) | undefined;
  constructor(host: DeckZoomHost, notify: (state: DeckZoomState) => void = () => {}) {
    this.#host = host;
    this.#notify = notify;
  }
  get state(): DeckZoomState {
    return { phase: this.#phase, paneId: this.#paneId, commits: this.#commits };
  }

  toggle(paneId: string): void {
    const host = this.#host.host();
    const stage = this.#host.stage();
    const pane = this.#pane ?? this.#host.pane(paneId);
    if (!host || !stage || !pane) return;
    const entering = this.#phase === 'idle' || (this.#phase === 'leaving' && this.#paneId === paneId);
    const stageRect = this.#host.measure(stage);
    const rect = this.#host.measure(pane);
    // Read content before inserting the home anchor: until grid placement is
    // pinned, another grid child can temporarily create an implicit row.
    const surface = pane.querySelector<HTMLElement>('.terminal-surface');
    const contentRect = this.#host.measure(surface ?? pane);
    if (rect.width <= 0 || rect.height <= 0 || stageRect.width <= 0 || stageRect.height <= 0) return;
    this.#cancel();
    if (this.#phase === 'idle') {
      this.#paneId = paneId;
      this.#pane = pane;
      this.#home = rect;
      // Keep a grid occupant at home. Its rect stays correct if the window or
      // split ratios change while fullscreen; siblings never move tracks.
      const anchor = pane.ownerDocument.createElement('div');
      anchor.setAttribute('data-vf-zoom-home', '');
      anchor.setAttribute('aria-hidden', 'true');
      const parent = pane.parentElement;
      const track = parent?.firstElementChild === pane ? '1' : '3';
      anchor.style.gridArea = parent?.classList.contains('is-vertical') ? `${track} / 1` : `1 / ${track}`;
      parent?.append(anchor);
      this.#anchor = anchor;
      pane.setAttribute(MARKER, '');
    }
    // Pin the content only once per completed gesture. Reversal retains the
    // original dimensions and never reflows the shell mid-animation.
    if (this.#phase === 'idle' || this.#phase === 'zoomed') {
      const size = contentRect;
      pane.style.setProperty('--vf-zoom-content-width', `${size.width}px`);
      pane.style.setProperty('--vf-zoom-content-height', `${size.height}px`);
    }
    this.#writeRect(rect, stageRect);
    this.#phase = entering ? 'entering' : 'leaving';
    host.setAttribute('data-zoom-layout', 'pane');
    host.setAttribute('data-zoom-phase', this.#phase);
    const duration = this.#host.reducedMotion() ? ZOOM_REDUCED_DURATION_MS : ZOOM_DURATION_MS;
    host.style.setProperty('--vf-zoom-duration', `${duration}ms`);
    // Flush the start box before changing the destination in the next frame.
    // Only the frame changes layout during motion; the pinned surface does not.
    this.#host.measure(pane);
    this.#raf = this.#host.raf(() => {
      this.#raf = undefined;
      const currentStage = this.#host.measure(stage);
      const home = this.#anchor ? this.#host.measure(this.#anchor) : this.#home!;
      this.#writeRect(entering ? currentStage : home, currentStage);
      this.#onEnd = (event) => {
        if (event.target !== pane || !PROPERTIES.includes((event as TransitionEvent).propertyName)) return;
        this.#settle(entering);
      };
      pane.addEventListener('transitionend', this.#onEnd);
      this.#timer = this.#host.timeout(() => this.#settle(entering), duration + ZOOM_COMMIT_GRACE_MS);
    });
    this.#notify(this.state);
  }

  /** A pane disappearing, a split changing, or the host unmounting cancels all owned styles. */
  reset(): void {
    this.#cancel();
    if (this.#phase === 'zoomed' || this.#phase === 'leaving') this.#commits += 1;
    this.#clean();
    this.#notify(this.state);
  }

  validate(): void {
    if (this.#paneId && (this.#host.pane(this.#paneId) !== this.#pane || !this.#anchor?.isConnected)) this.reset();
  }

  #settle(entering: boolean): void {
    this.#cancel();
    this.#commits += 1;
    if (entering) {
      this.#phase = 'zoomed';
      this.#host.host()?.setAttribute('data-zoom-phase', 'zoomed');
      this.#unpin();
    } else this.#clean();
    this.#notify(this.state);
  }
  #unpin(): void {
    this.#pane?.style.removeProperty('--vf-zoom-content-width');
    this.#pane?.style.removeProperty('--vf-zoom-content-height');
  }
  #clean(): void {
    this.#unpin();
    this.#pane?.removeAttribute(MARKER);
    for (const property of PROPERTIES) this.#pane?.style.removeProperty(`--vf-zoom-${property}`);
    this.#anchor?.remove();
    this.#anchor = null;
    this.#pane = null;
    this.#home = null;
    this.#paneId = null;
    this.#phase = 'idle';
    this.#host.host()?.removeAttribute('data-zoom-layout');
    this.#host.host()?.setAttribute('data-zoom-phase', 'idle');
  }
  #writeRect(rect: ZoomRect, stage: ZoomRect): void {
    for (const property of PROPERTIES) {
      const value =
        property === 'left'
          ? rect.left - stage.left
          : property === 'top'
            ? rect.top - stage.top
            : rect[property as 'width' | 'height'];
      this.#pane?.style.setProperty(`--vf-zoom-${property}`, `${value}px`);
    }
  }
  #cancel(): void {
    if (this.#raf !== undefined) this.#host.cancelRaf(this.#raf);
    if (this.#timer !== undefined) this.#host.cancelTimeout(this.#timer);
    if (this.#onEnd) this.#pane?.removeEventListener('transitionend', this.#onEnd);
    this.#raf = undefined;
    this.#timer = undefined;
    this.#onEnd = undefined;
  }
}
export function browserZoomHost(host: () => HTMLElement | null): DeckZoomHost {
  return {
    host,
    stage: () => host()?.querySelector<HTMLElement>('.terminal-host') ?? null,
    pane: (id) => host()?.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(id)}"]`) ?? null,
    measure: (element) => {
      const stage = host()?.querySelector<HTMLElement>('.terminal-host');
      const rect = element.getBoundingClientRect();
      if (!stage) return rect;
      // The app may itself be entering under a CSS scale. Read in stage-local
      // layout pixels, or pinning a transformed content rect would resize the
      // terminal before the fullscreen animation even starts.
      const bounds = stage.getBoundingClientRect();
      const style = getComputedStyle(stage);
      const sx = bounds.width / (Number.parseFloat(style.width) || bounds.width) || 1;
      const sy = bounds.height / (Number.parseFloat(style.height) || bounds.height) || 1;
      return {
        left: (rect.left - bounds.left) / sx,
        top: (rect.top - bounds.top) / sy,
        // CSS layout sizes avoid multiplying floating-point transform rounding
        // into a different subpixel content height at the pin/release boundary.
        width: layoutSize(element, 'width') ?? rect.width / sx,
        height: layoutSize(element, 'height') ?? rect.height / sy,
      };
    },
    reducedMotion: () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
    raf: (callback) => window.requestAnimationFrame(callback),
    cancelRaf: (id) => window.cancelAnimationFrame(id),
    timeout: (callback, ms) => window.setTimeout(callback, ms),
    cancelTimeout: (id) => window.clearTimeout(id),
  };
}

function layoutSize(element: HTMLElement, dimension: 'width' | 'height'): number | undefined {
  const style = getComputedStyle(element);
  const value = Number.parseFloat(style[dimension]);
  if (!Number.isFinite(value)) return undefined;
  if (style.boxSizing === 'border-box') return value;
  const sides = dimension === 'width' ? ['Left', 'Right'] : ['Top', 'Bottom'];
  return sides.reduce(
    (size, side) =>
      size +
      (Number.parseFloat(style.getPropertyValue(`padding-${side.toLowerCase()}`)) || 0) +
      (Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) || 0),
    value,
  );
}
