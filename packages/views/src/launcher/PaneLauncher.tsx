import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PaneLauncherChrome, type LauncherBusy } from './PaneLauncherChrome.js';
import {
  LAUNCHER_RECENT_LIMIT,
  LAUNCHER_SEARCH_DEBOUNCE_MS,
  LAUNCHER_SHORT_HEIGHT,
  buildLauncherResults,
  launcherFolder,
  moveHighlight,
  toggleScope,
  type LauncherKeyAction,
  type LauncherKeyState,
  type LauncherScope,
} from './launcher-model.js';
import type {
  LauncherAgent,
  LauncherHistoryStatus,
  LauncherOutcome,
  LauncherPort,
  LauncherSession,
  LauncherWordHit,
} from './launcher-port.js';

/** How long the launcher takes to leave once a launch or a resume is accepted (§22 "motion"). */
export const LAUNCHER_LEAVE_MS = 120;

/**
 * What `DeckLaunchers`' window key listener asks of the launcher in the
 * focused pane: its key state, and to act on a key the launcher took.
 */
export interface PaneLauncherController {
  keyState(): LauncherKeyState;
  apply(action: LauncherKeyAction): void;
}

export interface PaneLauncherProps {
  /** Ghosttea's pane element; the launcher is portalled into it. */
  pane: HTMLElement;
  paneId: string;
  /** The fresh shell's session, which a launch or a resume replaces. */
  sessionId: string;
  /** The pane's folder: where a launch starts, and what "here" means. */
  cwd?: string | undefined;
  /** The pane colour the host dealt this pane. */
  color?: string | undefined;
  /** The pane is the selected one. */
  active: boolean;
  /** The agents in launch order (`orderAgents`). */
  agents: readonly LauncherAgent[];
  port: LauncherPort;
  /** The scope the field opens on; remembered across launchers by the mounter. */
  scope: LauncherScope;
  onScopeChange(scope: LauncherScope): void;
  /** A paste reached the pane's terminal: the shell has input now. */
  onUsed(): void;
  /** A launch or a resume was accepted and the launcher has left. */
  onDone(): void;
  /** The mounter's handle on this launcher's keys; `null` on unmount. */
  register(controller: PaneLauncherController | null): void;
  /** A fixed clock for ages; the time the field opened by default. */
  nowMs?: number | undefined;
}

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'no answer';
}

function focusTerminal(pane: HTMLElement): void {
  pane.querySelector<HTMLTextAreaElement>('textarea')?.focus();
}

/**
 * One launcher, portalled into its pane: the field's query, scope, highlight
 * and results; the history and words questions to the port; the launch and
 * the resume with their pressed, leaving and refused states; and the focus —
 * into the field when it opens, back to the terminal when it closes. Unlike the
 * pane frame, the launcher takes the keyboard while its field is open.
 */
export function PaneLauncher({
  pane,
  paneId,
  sessionId,
  cwd,
  color,
  active,
  agents,
  port,
  scope,
  onScopeChange,
  onUsed,
  onDone,
  register,
  nowMs,
}: PaneLauncherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState<LauncherHistoryStatus>();
  const [sessions, setSessions] = useState<readonly LauncherSession[]>();
  const [hits, setHits] = useState<readonly LauncherWordHit[]>([]);
  const [highlight, setHighlight] = useState(-1);
  const [hoverIndex, setHoverIndex] = useState<number>();
  const [busy, setBusy] = useState<LauncherBusy>();
  const [failure, setFailure] = useState<string>();
  const [short, setShort] = useState(false);
  const [clock, setClock] = useState(() => nowMs ?? Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  const recentSequence = useRef(0);
  const wordsSequence = useRef(0);
  const alive = useRef(true);
  const folder = launcherFolder(cwd);
  // The mounter's callbacks may be new on every render; the effects that use
  // them should not re-subscribe for it.
  const callbacks = useRef({ onUsed, onDone, register });
  callbacks.current = { onUsed, onDone, register };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Short panes: the agents become one row of marks. Measured once at mount
  // as well, because an occluded window delivers no resize notifications.
  useEffect(() => {
    const apply = (height: number): void => setShort(height > 0 && height < LAUNCHER_SHORT_HEIGHT);
    apply(pane.getBoundingClientRect().height);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) apply(entry.borderBoxSize[0]?.blockSize ?? pane.getBoundingClientRect().height);
    });
    observer.observe(pane);
    return () => observer.disconnect();
  }, [pane]);

  // A paste into the terminal is input for the shell; one into the field is not.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      if (event.target instanceof Node && inputRef.current?.contains(event.target)) return;
      callbacks.current.onUsed();
    };
    pane.addEventListener('paste', onPaste, true);
    return () => pane.removeEventListener('paste', onPaste, true);
  }, [pane]);

  // Leaving with the keyboard inside the launcher hands it back to the
  // terminal. A layout cleanup runs while the field is still in the document.
  useLayoutEffect(() => {
    return () => {
      const input = inputRef.current;
      if (input && document.activeElement === input) focusTerminal(pane);
    };
  }, [pane]);

  // The folder's sessions: when the field opens and whenever the scope changes.
  // A late answer to an older question is ignored; a port that throws is a
  // history service that isn't answering.
  useEffect(() => {
    if (!open) return;
    recentSequence.current += 1;
    const mine = recentSequence.current;
    void port
      .recent({ ...(cwd ? { cwd } : {}), scope, limit: LAUNCHER_RECENT_LIMIT })
      .then((response) => {
        if (!alive.current || mine !== recentSequence.current) return;
        setHistory(response.status);
        setSessions(response.sessions);
      })
      .catch((error: unknown) => {
        if (!alive.current || mine !== recentSequence.current) return;
        setHistory({ readiness: 'unreachable', detail: reasonOf(error) });
        setSessions([]);
      });
  }, [open, port, cwd, scope]);

  // The words lane: one debounced question per pause in typing. A port that
  // had no answer leaves the last hits in place rather than blanking them.
  useEffect(() => {
    const trimmed = query.trim();
    if (!open || !port.words || trimmed === '') {
      setHits([]);
      return;
    }
    wordsSequence.current += 1;
    const mine = wordsSequence.current;
    const words = port.words.bind(port);
    const timer = window.setTimeout(() => {
      void words({ query: trimmed, ...(cwd ? { cwd } : {}), scope, limit: LAUNCHER_RECENT_LIMIT })
        .then((response) => {
          if (!alive.current || mine !== wordsSequence.current || !response.answered) return;
          setHits(response.hits);
        })
        .catch(() => undefined);
    }, LAUNCHER_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, port, cwd, scope, query]);

  // Opening sets the clock and takes the keyboard into the field.
  useEffect(() => {
    if (!open) return;
    setClock(nowMs ?? Date.now());
    inputRef.current?.focus();
  }, [open, nowMs]);

  const results = useMemo(
    () => (sessions ? buildLauncherResults({ sessions, hits, query, scope, folder, agents, nowMs: clock }) : undefined),
    [sessions, hits, query, scope, folder, agents, clock],
  );
  const rows = results?.rows ?? [];
  // New rows put the highlight on the first, so ↵ lands at once.
  const rowsKey = rows.map((row) => row.session.key).join('\n');
  useEffect(() => {
    setHighlight(rowsKey === '' ? -1 : 0);
  }, [rowsKey]);

  const settle = useCallback(
    (outcome: LauncherOutcome, next: LauncherBusy, refused: (reason: string) => string): void => {
      if (!alive.current) return;
      if (outcome.accepted) {
        setBusy({ ...next, leaving: true });
        window.setTimeout(() => {
          if (alive.current) callbacks.current.onDone();
        }, LAUNCHER_LEAVE_MS);
      } else {
        setBusy(undefined);
        setFailure(refused(outcome.reason));
      }
    },
    [],
  );

  const launch = (index: number): void => {
    const agent = agents[index];
    if (!agent || busy) return;
    if (agent.unavailable) {
      setFailure(`${agent.label} can’t launch: ${agent.unavailable}`);
      return;
    }
    const next: LauncherBusy = { kind: 'launch', index };
    const refused = (reason: string): string => `${agent.label} didn’t launch: ${reason}`;
    setFailure(undefined);
    setBusy(next);
    void port
      .launch({ paneId, sessionId, providerId: agent.providerId, ...(cwd ? { cwd } : {}) })
      .then((outcome) => settle(outcome, next, refused))
      .catch((error: unknown) => settle({ accepted: false, reason: reasonOf(error) }, next, refused));
  };

  const resume = (index: number): void => {
    const row = rows[index];
    if (!row || !row.session.resumable || busy) return;
    const next: LauncherBusy = { kind: 'resume', index };
    const refused = (reason: string): string => `“${row.session.title}” didn’t resume: ${reason}`;
    setFailure(undefined);
    setBusy(next);
    void port
      .resume({ paneId, sessionId, session: row.session, ...(cwd ? { cwd } : {}) })
      .then((outcome) => settle(outcome, next, refused))
      .catch((error: unknown) => settle({ accepted: false, reason: reasonOf(error) }, next, refused));
  };

  const close = (refocus: boolean): void => {
    setOpen(false);
    setQuery('');
    if (refocus) focusTerminal(pane);
  };

  // The key listener lives in the mounter and reads this launcher through a
  // stable handle; the handle reads the latest render through a ref.
  const latest = useRef({ open, highlight, rows, agents, busy, launch, resume, close, scope, onScopeChange });
  latest.current = { open, highlight, rows, agents, busy, launch, resume, close, scope, onScopeChange };
  const controller = useMemo<PaneLauncherController>(
    () => ({
      keyState: () => {
        const now = latest.current;
        return {
          open: now.open,
          agentCount: now.agents.length,
          highlight: now.highlight,
          highlightResumable: now.rows[now.highlight]?.session.resumable ?? false,
          launching: now.busy !== undefined,
        };
      },
      apply: (action) => {
        const now = latest.current;
        switch (action.kind) {
          case 'launch':
            now.launch(action.index);
            return;
          case 'open':
            setOpen(true);
            return;
          case 'close':
            now.close(true);
            return;
          case 'move':
            setHighlight((current) => moveHighlight(current, action.delta, now.rows.length));
            return;
          case 'resume':
            now.resume(action.index);
            return;
          case 'toggle-scope':
            now.onScopeChange(toggleScope(now.scope));
            return;
          default:
            return;
        }
      },
    }),
    [],
  );
  useEffect(() => {
    const registry = callbacks.current.register;
    registry(controller);
    return () => registry(null);
  }, [controller]);

  return createPortal(
    <PaneLauncherChrome
      sessionId={sessionId}
      agents={agents}
      folder={folder}
      {...(color ? { color } : {})}
      active={active}
      short={short}
      open={open}
      query={query}
      scope={scope}
      {...(open && results ? { results } : {})}
      highlight={highlight}
      {...(history ? { history } : {})}
      {...(hoverIndex !== undefined ? { hoverIndex } : {})}
      {...(busy ? { busy } : {})}
      {...(failure ? { failure } : {})}
      inputRef={inputRef}
      onQueryChange={setQuery}
      onOpen={() => setOpen(true)}
      onFieldBlur={() => {
        // Focus left for somewhere the person chose: the field closes where it is.
        if (latest.current.open) close(false);
      }}
      onLaunch={launch}
      onHover={setHoverIndex}
      onResume={resume}
      onHighlight={setHighlight}
      onScope={onScopeChange}
    />,
    pane,
  );
}
