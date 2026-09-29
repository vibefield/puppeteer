import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { LAUNCHER_SOURCE_ATTRIBUTE, PaneLauncherChrome, type LauncherBusy } from './PaneLauncherChrome.js';
import { launchSource, type LaunchRect, type LaunchVerb } from './launch-model.js';
import {
  LAUNCHER_RECENT_LIMIT,
  LAUNCHER_SEARCH_DEBOUNCE_MS,
  LAUNCHER_SHORT_HEIGHT,
  buildLauncherResults,
  cantLaunchLine,
  launcherFolder,
  moveHighlight,
  toggleScope,
  type LauncherKeyAction,
  type LauncherKeyState,
  type LauncherScope,
  type LauncherWordsQuestion,
} from './launcher-model.js';
import type {
  LauncherAgent,
  LauncherHistoryStatus,
  LauncherPort,
  LauncherSession,
  LauncherWordHit,
} from './launcher-port.js';

/**
 * How long the launcher took to leave once a launch was accepted (QL-1). Since
 * QL-2 it leaves at the click, before the request goes out; a host that waits
 * this long before mounting what came back waits for nothing it needs to.
 */
export const LAUNCHER_LEAVE_MS = 120;

/** What the launcher hands its mounter in the click's frame: the verb, the row, and where its mark was. */
export interface PaneLauncherLaunchRequest {
  verb: LaunchVerb;
  /** The agent's row (a launch) or the result's row (a resume). */
  index: number;
  providerId?: string | undefined;
  /** The agent, as the row names it: the launch's caption. */
  label: string;
  /** The past session a resume continues. */
  session?: LauncherSession | undefined;
  /** The row's mark at the click, in the pane's own pixels: where the launch's mark starts. */
  from: LaunchRect;
}

/** The mounter's launch in this launcher's pane, as the launcher draws it. */
export interface PaneLauncherLaunch {
  verb: LaunchVerb;
  index: number;
  /** A refusal is bringing the mark back: the launcher is back, the row still empty. */
  returning: boolean;
}

/**
 * How many frames a click in a resting pane's field waits for the pane's own
 * focus to land before the field opens anyway. Counted in frames, not time:
 * a loaded host can take longer than any timeout between two frames, and a
 * timer that fired first would open the field just before the selection's
 * focus took it away again.
 */
export const LAUNCHER_ACTIVATION_SETTLE_FRAMES = 4;

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
  /**
   * Select this pane: called first on a pointer in the launcher while the pane
   * is resting (the pane's own activation never sees a portal's events).
   * Without it, a click in a resting launcher leaves the selection alone.
   */
  onActivate?: (() => void) | undefined;
  /** The agents in launch order (`orderAgents`). */
  agents: readonly LauncherAgent[];
  port: LauncherPort;
  /** The scope the field opens on; remembered across launchers by the mounter. */
  scope: LauncherScope;
  onScopeChange(scope: LauncherScope): void;
  /** A paste reached the pane's terminal: the shell has input now. */
  onUsed(): void;
  /**
   * Launch an agent or resume a session in this pane (QL-2): called in the
   * click's frame, before any request; the mounter owns the port call and its
   * answer, because a launcher can unmount before its port answers.
   */
  onLaunch(request: PaneLauncherLaunchRequest): void;
  /** The mounter's launch in this pane, while there is one. */
  launch?: PaneLauncherLaunch | undefined;
  /** Why the last launch or resume from here was refused, in the host's words. */
  failure?: string | undefined;
  /** The mounter's handle on this launcher's keys; `null` on unmount. */
  register(controller: PaneLauncherController | null): void;
  /** A fixed clock for ages; the time the field opened by default. */
  nowMs?: number | undefined;
}

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'no answer';
}

/** Ghosttea's terminal input; any textarea in the pane for a host that names it otherwise. */
function focusTerminal(pane: HTMLElement): void {
  (pane.querySelector<HTMLElement>('.terminal-input') ?? pane.querySelector<HTMLElement>('textarea'))?.focus();
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
  onActivate,
  agents,
  port,
  scope,
  onScopeChange,
  onUsed,
  onLaunch,
  launch: launching,
  failure: refusal,
  register,
  nowMs,
}: PaneLauncherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState<LauncherHistoryStatus>();
  const [sessions, setSessions] = useState<readonly LauncherSession[]>();
  // Each hit set with the question it answered: the list uses it only while
  // that is still the question.
  const [words, setWords] = useState<{ question: LauncherWordsQuestion; hits: readonly LauncherWordHit[] }>();
  const [highlight, setHighlight] = useState(-1);
  const [hoverIndex, setHoverIndex] = useState<number>();
  const [failure, setFailure] = useState<string>();
  const [departOrigin, setDepartOrigin] = useState<string>();
  const rootRef = useRef<HTMLDivElement>(null);
  // The launch is the mounter's; the launcher only draws its row leaving and coming back.
  const busy: LauncherBusy | undefined = launching
    ? { kind: launching.verb, index: launching.index, leaving: !launching.returning, returning: launching.returning }
    : undefined;
  const [short, setShort] = useState(false);
  const [clock, setClock] = useState(() => nowMs ?? Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  const recentSequence = useRef(0);
  const wordsSequence = useRef(0);
  const alive = useRef(true);
  const folder = launcherFolder(cwd);
  // The mounter's callbacks may be new on every render; the effects that use
  // them should not re-subscribe for it.
  const callbacks = useRef({ onUsed, onLaunch, register, onActivate });
  callbacks.current = { onUsed, onLaunch, register, onActivate };
  /** A click in a resting pane's field that opens the field once the pane is selected; its undo. */
  const pendingOpen = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      pendingOpen.current?.();
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

  // A paste into the terminal is input for the shell; one into the field is
  // not. While a launch or a resume is in flight the shell is about to close:
  // a paste is held there like a key, and does not count as input.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      if (event.target instanceof Node && inputRef.current?.contains(event.target)) return;
      if (latest.current.busy) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
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
  // had no answer keeps the last hits, which still apply only to their own
  // question (`buildLauncherResults` leaves stale ones out).
  useEffect(() => {
    const trimmed = query.trim();
    if (!open || !port.words || trimmed === '') {
      setWords(undefined);
      return;
    }
    wordsSequence.current += 1;
    const mine = wordsSequence.current;
    const words = port.words.bind(port);
    const timer = window.setTimeout(() => {
      void words({ query: trimmed, ...(cwd ? { cwd } : {}), scope, limit: LAUNCHER_RECENT_LIMIT })
        .then((response) => {
          if (!alive.current || mine !== wordsSequence.current || !response.answered) return;
          setWords({ question: { query: trimmed, scope }, hits: response.hits });
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
    () =>
      sessions
        ? buildLauncherResults({
            sessions,
            hits: words?.hits ?? [],
            hitsFor: words?.question ?? { query: '', scope },
            query,
            scope,
            folder,
            agents,
            nowMs: clock,
          })
        : undefined,
    [sessions, words, query, scope, folder, agents, clock],
  );
  const rows = results?.rows ?? [];
  // New rows put the highlight on the first, so ↵ lands at once.
  const rowsKey = rows.map((row) => row.session.key).join('\n');
  useEffect(() => {
    setHighlight(rowsKey === '' ? -1 : 0);
  }, [rowsKey]);

  /**
   * The row's mark, in the pane's own pixels, and the point the launcher block
   * shrinks toward (C1). A row the narrow tiers hide has no box: the launch's
   * mark then rises from the launcher's middle, small.
   */
  const takeMark = (source: string): LaunchRect => {
    const root = rootRef.current;
    const paneBox = pane.getBoundingClientRect();
    const mark = root?.querySelector<HTMLElement>(`[${LAUNCHER_SOURCE_ATTRIBUTE}="${source}"] .vf-pane-launcher-mark`);
    const box = mark?.getBoundingClientRect();
    const block = root?.querySelector<HTMLElement>('.vf-pane-launcher');
    let from: LaunchRect;
    if (box && box.width > 0 && box.height > 0) {
      from = { x: box.left - paneBox.left, y: box.top - paneBox.top, width: box.width, height: box.height };
    } else {
      const centre = block?.getBoundingClientRect();
      const x = centre ? centre.left + centre.width / 2 - paneBox.left : paneBox.width / 2;
      const y = centre ? centre.top + Math.min(centre.height, 64) / 2 - paneBox.top : paneBox.height / 2;
      from = { x: x - 8, y: y - 8, width: 16, height: 16 };
    }
    if (block) {
      // The block is centred with translateX(-50%): its own box starts half a width left of `offsetLeft`.
      const ox = from.x + from.width / 2 - (block.offsetLeft - block.offsetWidth / 2);
      const oy = from.y + from.height / 2 - block.offsetTop;
      setDepartOrigin(`${ox.toFixed(1)}px ${oy.toFixed(1)}px`);
    }
    return from;
  };

  const launch = (index: number): void => {
    const agent = agents[index];
    if (!agent || busy) return;
    if (agent.unavailable) {
      setFailure(cantLaunchLine(agent));
      return;
    }
    setFailure(undefined);
    callbacks.current.onLaunch({
      verb: 'launch',
      index,
      providerId: agent.providerId,
      label: agent.label,
      from: takeMark(launchSource('launch', index)),
    });
  };

  const resume = (index: number): void => {
    const row = rows[index];
    if (!row || !row.session.resumable || busy) return;
    const agent = agents.find((candidate) => candidate.providerId === row.session.providerId);
    setFailure(undefined);
    callbacks.current.onLaunch({
      verb: 'resume',
      index,
      ...(row.session.providerId ? { providerId: row.session.providerId } : {}),
      label: agent?.label ?? row.session.title,
      session: row.session,
      from: takeMark(launchSource('resume', index)),
    });
  };

  const close = (refocus: boolean): void => {
    setOpen(false);
    setQuery('');
    if (refocus) focusTerminal(pane);
  };

  // A pointer in a resting pane's launcher selects the pane first. Selecting it
  // makes Ghosttea focus the pane's terminal on the next frame (a callback it
  // queues before any of ours), and that focus queues itself once more for the
  // frame after; a field that took the click's focus at once would lose it and
  // close. So a click in the field does not focus it: the field opens two
  // frames after the pane holds the keyboard, or after
  // `LAUNCHER_ACTIVATION_SETTLE_FRAMES` if it never comes to.
  const onRootPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const activate = callbacks.current.onActivate;
    if (active || !activate) return;
    activate();
    if (!(event.target instanceof Element) || !event.target.closest('.vf-pane-launcher-field')) return;
    event.preventDefault();
    if (pendingOpen.current) return;
    let settled = false;
    let frames = 0;
    let landedAt: number | undefined;
    let frame = 0;
    const undo = (): void => {
      settled = true;
      window.cancelAnimationFrame(frame);
      if (pendingOpen.current === undo) pendingOpen.current = undefined;
    };
    const tick = (): void => {
      if (settled) return;
      frames += 1;
      if (landedAt === undefined && pane.contains(document.activeElement)) landedAt = frames;
      const ready = landedAt !== undefined ? frames - landedAt >= 2 : frames >= LAUNCHER_ACTIVATION_SETTLE_FRAMES;
      if (!ready) {
        frame = window.requestAnimationFrame(tick);
        return;
      }
      undo();
      if (alive.current) inputRef.current?.focus();
    };
    frame = window.requestAnimationFrame(tick);
    pendingOpen.current = undo;
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
      {...(failure || refusal ? { failure: failure ?? refusal } : {})}
      inputRef={inputRef}
      rootRef={rootRef}
      {...(departOrigin ? { departOrigin } : {})}
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
      onRootPointerDown={onRootPointerDown}
      onRootMouseDown={(event) => {
        // The click that selected the pane leaves the focus to the pane (above).
        if (pendingOpen.current) event.preventDefault();
      }}
    />,
    pane,
  );
}
