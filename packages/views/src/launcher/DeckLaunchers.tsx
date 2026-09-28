import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { GHOSTTEA_PANE_SELECTOR, usePaneElements } from '../deck/pane-elements.js';
import { PaneLauncher, type PaneLauncherController } from './PaneLauncher.js';
import {
  LauncherKeyReleases,
  launcherKeyDecision,
  launcherPaneForTarget,
  orderAgents,
  showsLauncher,
  type LauncherKeyPane,
  type LauncherScope,
} from './launcher-model.js';
import type { LauncherAgent, LauncherPort } from './launcher-port.js';

/** A pane Ghosttea has laid out and the session it shows (a `DeckFramePane` fits). */
export interface DeckLauncherPane {
  id: string;
  session: { id: string; cwd?: string | null | undefined };
}

export interface DeckLaunchersProps {
  deckRef: RefObject<HTMLElement | null>;
  panes: readonly DeckLauncherPane[];
  /** The selected pane: its launcher draws the agents; a resting one keeps only its field. */
  activePaneId?: string | null | undefined;
  /**
   * Make this pane the selected one. A launcher is a portal, and React bubbles
   * a portal's pointer events along the React tree, so the pane's own
   * activation (Ghosttea's `onPointerDown` on the pane) never sees a click in
   * the launcher: the launcher calls this first instead. Without it, a click in
   * a resting pane's launcher does not select that pane.
   */
  onActivatePane?: ((paneId: string) => void) | undefined;
  /**
   * The shell sessions born in this view that may show a launcher (QL-D7 a–c:
   * the host's own new-pane/split door and the workspace's first pane, no agent
   * facet, not exited). Restored or attached sessions are never in it.
   */
  freshSessionIds: ReadonlySet<string>;
  /** The folder per SESSION id, where a launch starts; the pane summary's cwd is the fallback. */
  cwdBySession: ReadonlyMap<string, string>;
  /** The pane colours per PANE id. */
  paneColors: ReadonlyMap<string, string>;
  /** The host's agent catalog, in its own order; the launcher orders by last launch. */
  agents: readonly LauncherAgent[];
  port: LauncherPort;
  /** A host that knows a session already had input says so (QL-D7 d); the launcher also sees it itself. */
  hasInput?: ((sessionId: string) => boolean) | undefined;
  /** The launcher saw input reach a fresh shell: a key it let through, or a paste. */
  onSessionUsed?: ((sessionId: string) => void) | undefined;
  /**
   * True while the focused pane shows a launcher, which then owns ⌥0–⌥9 and
   * ⌥↵ (QL-D2): a host's own ⌥-digit listener yields while it is set.
   */
  onOwnsKeysChange?: ((owns: boolean) => void) | undefined;
  /** How a pane element is found under the deck; Ghosttea's by default. */
  paneSelector?: string | undefined;
  /** A fixed clock for the session ages (a catalog's); the time the field opened by default. */
  nowMs?: number | undefined;
}

function addTo(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (set.has(id)) return set;
  const next = new Set(set);
  next.add(id);
  return next;
}

/**
 * The empty pane launchers, mounted by a host BESIDE `DeckFrames` (QL-1). A
 * pane gets one while its session is fresh, has had no input and was not
 * dismissed. ONE window capture listener, which runs before Ghosttea's
 * terminal textarea sees the key, gives each key to the launcher of the pane
 * that holds the key's target (its terminal or the launcher's own field),
 * active or not: that launcher owns ⌥0–⌥9, ⌥↵ and ⎋, and a key it does not
 * own goes on to the shell and takes the launcher away with it (the first
 * key is the shell's). A key the launcher took has its release taken too.
 */
export function DeckLaunchers({
  deckRef,
  panes,
  activePaneId,
  onActivatePane,
  freshSessionIds,
  cwdBySession,
  paneColors,
  agents,
  port,
  hasInput,
  onSessionUsed,
  onOwnsKeysChange,
  paneSelector = GHOSTTEA_PANE_SELECTOR,
  nowMs,
}: DeckLaunchersProps) {
  const elements = usePaneElements(deckRef, paneSelector, panes);
  const [used, setUsed] = useState<ReadonlySet<string>>(() => new Set());
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  // Here is the default and is remembered (§23), across the deck's launchers.
  const [scope, setScope] = useState<LauncherScope>('here');
  const controllers = useRef(new Map<string, PaneLauncherController>());
  const ordered = useMemo(() => orderAgents(agents), [agents]);

  const callbacks = useRef({ onSessionUsed, onOwnsKeysChange, onActivatePane });
  callbacks.current = { onSessionUsed, onOwnsKeysChange, onActivatePane };

  const markUsed = useCallback((sessionId: string): void => {
    setUsed((current) => addTo(current, sessionId));
    callbacks.current.onSessionUsed?.(sessionId);
  }, []);
  const dismiss = useCallback((sessionId: string): void => {
    setDismissed((current) => addTo(current, sessionId));
  }, []);

  const shown = panes.filter(
    (pane) =>
      elements.byId.has(pane.id) && showsLauncher(pane.session.id, { freshSessionIds, used, dismissed, hasInput }),
  );
  const owns = shown.some((pane) => pane.id === activePaneId);
  // The key listener reads the panes showing a launcher through a ref, so it is
  // added once rather than on every render.
  const routes = useRef<readonly LauncherKeyPane[]>([]);
  routes.current = shown.flatMap((pane) => {
    const element = elements.byId.get(pane.id);
    return element ? [{ paneId: pane.id, sessionId: pane.session.id, element }] : [];
  });

  useEffect(() => {
    if (!owns) return;
    callbacks.current.onOwnsKeysChange?.(true);
    return () => callbacks.current.onOwnsKeysChange?.(false);
  }, [owns]);

  // One listener for the deck's launchers, and only for keys routed into a pane
  // that shows one (its terminal or the launcher's own field): a key typed into
  // the host's other inputs is none of the launcher's business.
  useEffect(() => {
    const releases = new LauncherKeyReleases();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.target instanceof Node)) return;
      const route = launcherPaneForTarget(event.target, routes.current);
      if (!route) return;
      const controller = controllers.current.get(route.paneId);
      if (!controller) return;
      const decision = launcherKeyDecision(event, controller.keyState());
      if (decision.consume) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (decision.release) releases.took(event.code);
      }
      switch (decision.effect) {
        case 'none':
          return;
        case 'used':
          markUsed(route.sessionId);
          return;
        case 'dismiss':
          dismiss(route.sessionId);
          return;
        case 'apply':
          controller.apply(decision.action);
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (!releases.released(event.code)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [markUsed, dismiss]);

  return (
    <>
      {shown.map((pane) => {
        const element = elements.byId.get(pane.id);
        if (!element) return null;
        const sessionId = pane.session.id;
        const cwd = cwdBySession.get(sessionId) ?? pane.session.cwd ?? undefined;
        const color = paneColors.get(pane.id);
        return (
          <PaneLauncher
            key={`${pane.id}\n${sessionId}`}
            pane={element}
            paneId={pane.id}
            sessionId={sessionId}
            {...(cwd ? { cwd } : {})}
            {...(color ? { color } : {})}
            active={pane.id === activePaneId}
            {...(onActivatePane ? { onActivate: () => callbacks.current.onActivatePane?.(pane.id) } : {})}
            agents={ordered}
            port={port}
            scope={scope}
            onScopeChange={setScope}
            onUsed={() => markUsed(sessionId)}
            onDone={() => dismiss(sessionId)}
            register={(controller) => {
              if (controller) controllers.current.set(pane.id, controller);
              else if (controllers.current.get(pane.id)) controllers.current.delete(pane.id);
            }}
            {...(nowMs !== undefined ? { nowMs } : {})}
          />
        );
      })}
    </>
  );
}
