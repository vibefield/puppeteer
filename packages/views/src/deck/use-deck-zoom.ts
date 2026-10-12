import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { browserZoomHost, DeckZoomController, type DeckZoomState } from './deck-zoom.js';
export interface DeckZoom {
  readonly state: DeckZoomState;
  toggle(paneId: string): void;
  reset(): void;
}
/** The host passes toggle to GhostteaWorkspace.onTogglePaneZoom and its pane-frame verb. */
export function useDeckZoom(
  hostRef: RefObject<HTMLElement | null>,
  activePaneId: string | undefined,
  onState?: (state: DeckZoomState) => void,
  enabled = true,
): DeckZoom {
  const live = useRef({ activePaneId, onState, enabled });
  live.current = { activePaneId, onState, enabled };
  const [state, setState] = useState<DeckZoomState>({ phase: 'idle', paneId: null, commits: 0 });
  const controller = useRef<DeckZoomController | null>(null);
  if (!controller.current)
    controller.current = new DeckZoomController(
      browserZoomHost(() => hostRef.current),
      (next) => {
        setState(next);
        live.current.onState?.(next);
      },
    );
  const zoom = controller.current;
  const toggle = useCallback((id: string) => zoom.toggle(id), [zoom]);
  const reset = useCallback(() => zoom.reset(), [zoom]);
  useLayoutEffect(() => () => zoom.reset(), [zoom]);
  useLayoutEffect(() => {
    zoom.validate();
    const observer = new MutationObserver(() => zoom.validate());
    if (hostRef.current) observer.observe(hostRef.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [hostRef, activePaneId, zoom]);
  useLayoutEffect(() => {
    if (!enabled || !activePaneId) zoom.reset();
  }, [activePaneId, enabled, zoom]);
  return { state, toggle, reset };
}
