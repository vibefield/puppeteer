import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { GHOSTTEA_PANE_SELECTOR, usePaneElements } from '../deck/pane-elements.js';
import { PaneLauncher, type PaneLauncherController } from './PaneLauncher.js';
import { consumesKey, launcherKeyAction, orderAgents, showsLauncher, type LauncherScope } from './launcher-model.js';
import type { LauncherAgent, LauncherPort } from './launcher-port.js';

/** A pane Ghosttea has laid out and the session it shows (a `DeckFramePane` fits). */
export interface DeckLauncherPane {
  id: string;
  session: { id: string; cwd?: string | null | undefined };
}

export interface DeckLaunchersProps {
  deckRef: RefObject<HTMLElement | null>;
  panes: readonly DeckLauncherPane[];
  /** The selected pane: the one whose launcher owns the keys. */
  activePaneId?: string | null | undefined;
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
 * dismissed; the launcher in the focused pane owns ⌥0–⌥9, ⌥↵ and ⎋ through
 * ONE window capture listener, which runs before Ghosttea's terminal textarea
 * sees the key. A key the launcher does not own goes on to the shell and
 * takes the launcher away with it (the first key is the shell's).
 */
export function DeckLaunchers({
  deckRef,
  panes,
  activePaneId,
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

  const callbacks = useRef({ onSessionUsed, onOwnsKeysChange });
  callbacks.current = { onSessionUsed, onOwnsKeysChange };

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
  const activePane = shown.find((pane) => pane.id === activePaneId);
  const activeElement = activePane ? elements.byId.get(activePane.id) : undefined;
  const activeSessionId = activePane?.session.id;
  const owns = activePane !== undefined;

  useEffect(() => {
    if (!owns) return;
    callbacks.current.onOwnsKeysChange?.(true);
    return () => callbacks.current.onOwnsKeysChange?.(false);
  }, [owns]);

  // One listener, only while the focused pane shows a launcher, and only for
  // keys routed into that pane (its terminal or the launcher's own field): a
  // key typed into the host's other inputs is none of the launcher's business.
  useEffect(() => {
    if (!activePane || !activeElement || activeSessionId === undefined) return;
    const paneId = activePane.id;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.target instanceof Node) || !activeElement.contains(event.target)) return;
      const controller = controllers.current.get(paneId);
      if (!controller) return;
      const action = launcherKeyAction(event, controller.keyState());
      if (consumesKey(action)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      switch (action.kind) {
        case 'ignore':
        case 'type':
        case 'hold':
          return;
        case 'used':
          markUsed(activeSessionId);
          return;
        case 'dismiss':
          dismiss(activeSessionId);
          return;
        default:
          controller.apply(action);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [activePane, activeElement, activeSessionId, markUsed, dismiss]);

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
