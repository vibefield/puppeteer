import { useMemo } from 'react';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import { useGhostteaRuntime } from '@vibecook/ghosttea-react';
import { useRemoteSessionLifecycle } from '@vibecook/ghosttea-react/workspace';
import { PaneFrame, type DeckFrameSlotProps, type PaneFrameVerbs } from '@vibecook/puppeteer-views';
import type { MonitorAgent } from '../monitor/types.js';
import { zoomKeyEvent } from './pane-frame.js';

/**
 * The app's frame is the package's (`@vibecook/puppeteer-views`, PU-14) with
 * the one fact only this host can add: the device a remote session lives on,
 * read from Ghosttea's own lifecycle for the pane's session.
 */
export function AppPaneFrame({ paneId: _paneId, session, ...props }: DeckFrameSlotProps) {
  const remote = useRemoteSessionLifecycle(session.id);
  return <PaneFrame session={session} {...props} {...(remote ? { remote: remote.deviceName } : {})} />;
}

/**
 * The verbs over this host's IPC. Stop is the agent's own native interrupt
 * (what ^C does in its TUI — there is no runtime interrupt service; the host
 * sends exactly that through Ghosttea's automation, which yields to a human
 * mid-keystroke). Resume continues an exited run from its own continuation and
 * mounts what comes back where the verb was pressed. Zoom presses exactly what
 * the user's own `toggle_split_zoom` binding would.
 */
export function useAppPaneFrameVerbs(
  agentsBySession: ReadonlyMap<string, MonitorAgent>,
  onResume: (session: SessionSummary) => void,
): PaneFrameVerbs {
  const runtime = useGhostteaRuntime();
  return useMemo<PaneFrameVerbs>(() => {
    const runtimeSessionId = (sessionId: string): string | undefined =>
      agentsBySession.get(sessionId)?.agent?.info.runtimeSessionId;
    return {
      stop: async (sessionId) => {
        const id = runtimeSessionId(sessionId);
        if (!id) return { accepted: false };
        const result = await window.puppeteer.interruptAgent(id);
        return { accepted: result.accepted };
      },
      resume: async (sessionId) => {
        const id = runtimeSessionId(sessionId);
        if (!id) return;
        const result = await window.puppeteer.resumeAgentSession(id);
        if ('error' in result) console.warn(`[deck] could not resume: ${result.error.message}`);
        else onResume(result.session);
      },
      zoom: (pane) => {
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
      },
      zoomShortcut: window.desktop.platform === 'darwin' ? '⌘⇧↵' : '⌃⇧↵',
    };
  }, [agentsBySession, onResume, runtime]);
}
