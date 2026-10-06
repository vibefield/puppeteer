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
 * When the host renders it with new children (the next state or frame of
 * facts), it tries the piece again. A transient read heals itself; the host's
 * reporter hears a persistent failure once per distinct error.
 */
export interface ChromeBoundaryProps {
  /** Which piece this is, for the report. */
  readonly name: string;
  /** Told each time the piece fails with an error unlike the last one it reported. */
  readonly onError?: ((error: unknown, name: string) => void) | undefined;
  readonly children?: ReactNode;
}

interface ChromeBoundaryState {
  readonly failed: boolean;
}

export class ChromeBoundary extends Component<ChromeBoundaryProps, ChromeBoundaryState> {
  override state: ChromeBoundaryState = { failed: false };
  private reported: string | undefined;

  static getDerivedStateFromError(): ChromeBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    const said = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (said === this.reported) return;
    this.reported = said;
    this.props.onError?.(error, this.props.name);
  }

  override componentDidUpdate(previous: ChromeBoundaryProps): void {
    // New children are the host's next render of the piece: try it again.
    if (this.state.failed && previous.children !== this.props.children) this.setState({ failed: false });
  }

  override render(): ReactNode {
    return this.state.failed ? <span role="status">{this.props.name} unavailable</span> : this.props.children;
  }
}
