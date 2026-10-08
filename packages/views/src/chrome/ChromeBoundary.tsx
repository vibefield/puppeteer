import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * A host's chrome piece behind its own error boundary (build-mv M49). The
 * chrome (the bar, the find sheet, the inspector, the deck's frames, the usage
 * column) reads facts beside the monitor's model, and one bad read in any piece
 * used to unmount the whole React tree: the monitor and its views went blank
 * with it (M47's race did exactly that). Behind this boundary only the piece
 * that threw goes; the stage, the view host and every other piece stay.
 *
 * A failed piece says it is unavailable; a healthy piece's DOM is unchanged.
 * It is tried again only when a fact that can fix it changes (M176 item 1),
 * never because its host rendered: a host that observes the piece's own box
 * renders again when the fallback replaces it, and retrying on that render
 * remounted a persistent failure in a loop.
 *
 * - **No `retryKey`:** the piece stays unavailable until the host remounts it.
 * - **A `retryKey`:** a change of it tries the piece again, at most once per
 *   window. The first window is {@link CHROME_RETRY_FIRST_MS}; each retry that
 *   fails again doubles it, up to {@link CHROME_RETRY_CAP_MS}. A change inside
 *   the window waits for its end and retries once with the facts standing
 *   then, so a key that changes on every publish cannot hot-loop.
 * - **The report:** `onError` hears a failure once per episode, from the first
 *   throw until the piece renders again, never once per retry.
 */
export interface ChromeBoundaryProps {
  /** Which piece this is, for the report. */
  readonly name: string;
  /** Told once per failure episode: when the piece first fails, not on each retry that fails again. */
  readonly onError?: ((error: unknown, name: string) => void) | undefined;
  /** The owning facts that can fix a failure: a change retries, within the backoff. Omitted, nothing retries. */
  readonly retryKey?: unknown;
  readonly children?: ReactNode;
}

/** The first backoff window after a failure, in ms. */
export const CHROME_RETRY_FIRST_MS = 1_000;
/** The longest window the doubling reaches, in ms. */
export const CHROME_RETRY_CAP_MS = 30_000;

interface ChromeBoundaryState {
  readonly failed: boolean;
}

export class ChromeBoundary extends Component<ChromeBoundaryProps, ChromeBoundaryState> {
  override state: ChromeBoundaryState = { failed: false };
  /** Inside a failure episode: from the first throw until the piece renders again. */
  private failing = false;
  /** The retry key the last attempt rendered with; only a different one is worth a retry. */
  private attemptKey: unknown;
  /** The current window's length, and when it ends. */
  private windowMs = 0;
  private retryAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  static getDerivedStateFromError(): ChromeBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    this.attemptKey = this.props.retryKey;
    if (this.failing) {
      // A retry that failed again: the same episode, a window twice as long.
      this.windowMs = Math.min(this.windowMs * 2, CHROME_RETRY_CAP_MS);
    } else {
      this.failing = true;
      this.windowMs = CHROME_RETRY_FIRST_MS;
      this.props.onError?.(error, this.props.name);
    }
    this.retryAt = Date.now() + this.windowMs;
  }

  override componentDidUpdate(_previous: ChromeBoundaryProps, previousState: ChromeBoundaryState): void {
    if (previousState.failed && !this.state.failed) {
      // The retry rendered: the episode is over, and the next failure starts a new one.
      this.failing = false;
      this.windowMs = 0;
      return;
    }
    if (this.state.failed) this.consider();
  }

  override componentWillUnmount(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Tries the piece again if its owning facts changed since the failed attempt: now, or when the window ends. */
  private consider(): void {
    if (!this.failing || this.timer !== undefined) return;
    if (!('retryKey' in this.props) || Object.is(this.props.retryKey, this.attemptKey)) return;
    const wait = this.retryAt - Date.now();
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.state.failed) this.consider();
      }, wait);
      return;
    }
    this.attemptKey = this.props.retryKey;
    this.setState({ failed: false });
  }

  override render(): ReactNode {
    return this.state.failed ? <span role="status">{this.props.name} unavailable</span> : this.props.children;
  }
}
