import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { GHOSTTEA_PANE_SELECTOR, usePaneElements } from '../deck/pane-elements.js';
import { PaneLaunch, type PaneLaunchOutcome } from './PaneLaunch.js';
import { PaneLauncher, type PaneLauncherController, type PaneLauncherLaunchRequest } from './PaneLauncher.js';
import {
  LAUNCH_INDICATOR_MS,
  LAUNCH_LATE_FRAME_MS,
  initialLaunch,
  launchSettled,
  launchSource,
  reduceLaunch,
  type LaunchEvent,
  type LaunchRect,
  type LaunchState,
  type LaunchVerb,
  type WatchFirstFrame,
} from './launch-model.js';
import {
  LauncherKeyReleases,
  launcherKeyDecision,
  launcherPaneForTarget,
  orderAgents,
  showsLauncher,
  type LauncherKeyPane,
  type LauncherScope,
} from './launcher-model.js';
import type { LauncherAgent, LauncherOutcome, LauncherPort, LauncherUnder } from './launcher-port.js';

/**
 * How long after a key the launcher let by (a ⌘/⌃ chord) it asks the host
 * again whether the shell took input: a binding's paste reads the clipboard
 * first and reaches the shell a moment later, with no event of its own.
 */
export const LAUNCHER_INPUT_RECHECK_MS = 250;

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
  /**
   * A host that knows a session already had input says so (QL-D7 d); the
   * launcher also sees it itself. Read at render, and asked again (the
   * host need not re-render for it) on every key into the pane, a key's
   * release, `LAUNCHER_INPUT_RECHECK_MS` after a chord the launcher let by,
   * a pointer in the pane, and the window regaining focus.
   */
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
  /**
   * Watch a born session for its first drawn frame (QL-2, C3): call `onDrawn`
   * once it has drawn (at once if it already has), and return the way to stop
   * watching. Without it a launch lands as soon as the port answers.
   */
  watchFirstFrame?: WatchFirstFrame | undefined;
  /** Reduced motion for the launches, when the host knows better than the media query. */
  reducedMotion?: boolean | undefined;
  /**
   * The Agent Profile a fresh pane's shell was born under, asked per pane
   * (SB): its caption and its own agents (`LauncherUnder`). Undefined for a
   * pane bound to none — it shows the shared `agents` and the plain caption.
   */
  paneUnder?: ((pane: { paneId: string; sessionId: string }) => LauncherUnder | undefined) | undefined;
}

/** One launch, held per PANE from the click to the first frame (C2): it outlives the launcher it came from. */
interface PaneLaunchRecord {
  id: string;
  paneId: string;
  /** The fresh shell the launcher sat on, which the launch replaces. */
  freshSessionId: string;
  verb: LaunchVerb;
  index: number;
  providerId?: string | undefined;
  label: string;
  /** The past session a resume continues, by its title: how the launcher's lines name it. */
  title?: string | undefined;
  from: LaunchRect;
  startedAt: number;
  state: LaunchState;
}

/** A line under a pane's launcher, for the session that launcher sits on (QL-1 kept it per launcher). */
interface PaneRefusal {
  sessionId: string;
  line: string;
}

/** What a launch holds besides its facts: its timers and its watch on the first frame. */
interface LaunchJob {
  timers: number[];
  unwatch?: (() => void) | undefined;
}

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'no answer';
}

/** The failure line under the rows, in the words QL-1 used. */
function refusalLine(request: PaneLauncherLaunchRequest, reason: string): string {
  return request.verb === 'resume'
    ? `“${request.session?.title ?? request.label}” didn’t resume: ${reason}`
    : `${request.label} didn’t launch: ${reason}`;
}

/** The line when the agent's session left its pane before it drew: it ran, and exited at once. */
function leftLine(record: PaneLaunchRecord): string {
  return `${record.verb === 'resume' ? `“${record.title ?? record.label}”` : record.label} exited before it opened`;
}

/** `paneId → sessionId` for the panes as the host lays them out, as one string an effect can key on. */
function paneSessionsKey(panes: readonly DeckLauncherPane[]): string {
  return panes.map((pane) => `${pane.id}\t${pane.session.id}`).join('\n');
}

function paneSessionsOf(key: string): Map<string, string> {
  const sessions = new Map<string, string>();
  if (key === '') return sessions;
  for (const row of key.split('\n')) {
    const tab = row.indexOf('\t');
    sessions.set(row.slice(0, tab), row.slice(tab + 1));
  }
  return sessions;
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
  watchFirstFrame,
  reducedMotion,
}: DeckLaunchersProps) {
  const elements = usePaneElements(deckRef, paneSelector, panes);
  const [used, setUsed] = useState<ReadonlySet<string>>(() => new Set());
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  // Here is the default and is remembered (§23), across the deck's launchers.
  const [scope, setScope] = useState<LauncherScope>('here');
  const controllers = useRef(new Map<string, PaneLauncherController>());
  const ordered = useMemo(() => orderAgents(agents), [agents]);

  const callbacks = useRef({ onSessionUsed, onOwnsKeysChange, onActivatePane, hasInput, port, watchFirstFrame });
  callbacks.current = { onSessionUsed, onOwnsKeysChange, onActivatePane, hasInput, port, watchFirstFrame };

  // ── the launches (QL-2): one per pane, from the click to the first frame ──
  const [launches, setLaunches] = useState<ReadonlyMap<string, PaneLaunchRecord>>(() => new Map());
  // Keyed by PANE, for the session its launcher sits on: a shell mirrored in
  // two panes shows a refusal only under the launcher it came from.
  const [refusals, setRefusals] = useState<ReadonlyMap<string, PaneRefusal>>(() => new Map());
  const launchesRef = useRef(launches);
  launchesRef.current = launches;
  const inFlight = useRef(new Set<string>());
  const jobs = useRef(new Map<string, LaunchJob>());
  const launchSequence = useRef(0);

  const release = useCallback((id: string): void => {
    const job = jobs.current.get(id);
    if (!job) return;
    for (const timer of job.timers) window.clearTimeout(timer);
    job.unwatch?.();
    jobs.current.delete(id);
  }, []);

  /** One fact for one launch; a fact for a launch already let go is dropped. */
  const advance = useCallback((paneId: string, id: string, event: LaunchEvent): void => {
    setLaunches((current) => {
      const record = current.get(paneId);
      if (!record || record.id !== id) return current;
      const state = reduceLaunch(record.state, event);
      if (state === record.state) return current;
      return new Map(current).set(paneId, { ...record, state });
    });
  }, []);

  const markUsed = useCallback((sessionId: string): void => {
    setUsed((current) => addTo(current, sessionId));
    callbacks.current.onSessionUsed?.(sessionId);
  }, []);
  const dismiss = useCallback((sessionId: string): void => {
    setDismissed((current) => addTo(current, sessionId));
  }, []);

  /** The port's answer to one launch: running and watching for its first frame, or refused. */
  const answer = useCallback(
    (
      paneId: string,
      id: string,
      freshSessionId: string,
      request: PaneLauncherLaunchRequest,
      outcome: LauncherOutcome,
    ) => {
      const job = jobs.current.get(id);
      if (!job) return;
      if (!outcome.accepted) {
        const line = refusalLine(request, outcome.reason);
        setRefusals((current) => new Map(current).set(paneId, { sessionId: freshSessionId, line }));
        advance(paneId, id, { type: 'refused', reason: outcome.reason });
        return;
      }
      advance(paneId, id, { type: 'running', sessionId: outcome.sessionId });
      const watch = callbacks.current.watchFirstFrame;
      if (!watch || outcome.sessionId === undefined) {
        // No way to know when it draws: it lands at the answer.
        advance(paneId, id, { type: 'drawn' });
        return;
      }
      job.timers.push(window.setTimeout(() => advance(paneId, id, { type: 'late' }), LAUNCH_LATE_FRAME_MS));
      job.unwatch = watch(outcome.sessionId, () => advance(paneId, id, { type: 'drawn' })) ?? undefined;
    },
    [advance],
  );

  /** C1: the launch begins in the click's frame; the request goes out after. */
  const startLaunch = useCallback(
    (pane: { id: string; sessionId: string; cwd?: string | undefined }, request: PaneLauncherLaunchRequest): void => {
      if (inFlight.current.has(pane.id)) return;
      inFlight.current.add(pane.id);
      // A launch still going out of this pane (its agent left) gives way to this one.
      const previous = launchesRef.current.get(pane.id);
      if (previous) release(previous.id);
      launchSequence.current += 1;
      const id = `launch-${launchSequence.current}`;
      const record: PaneLaunchRecord = {
        id,
        paneId: pane.id,
        freshSessionId: pane.sessionId,
        verb: request.verb,
        index: request.index,
        ...(request.providerId ? { providerId: request.providerId } : {}),
        label: request.label,
        ...(request.session?.title ? { title: request.session.title } : {}),
        from: request.from,
        startedAt: performance.now(),
        state: initialLaunch(),
      };
      setLaunches((current) => new Map(current).set(pane.id, record));
      setRefusals((current) => {
        if (!current.has(pane.id)) return current;
        const next = new Map(current);
        next.delete(pane.id);
        return next;
      });
      const job: LaunchJob = { timers: [] };
      jobs.current.set(id, job);
      job.timers.push(window.setTimeout(() => advance(pane.id, id, { type: 'indicator' }), LAUNCH_INDICATOR_MS));
      const currentPort = callbacks.current.port;
      const cwd = pane.cwd ? { cwd: pane.cwd } : {};
      let asked: Promise<LauncherOutcome>;
      try {
        asked =
          request.verb === 'resume' && request.session
            ? currentPort.resume({ paneId: pane.id, sessionId: pane.sessionId, session: request.session, ...cwd })
            : currentPort.launch({
                paneId: pane.id,
                sessionId: pane.sessionId,
                providerId: request.providerId ?? '',
                ...cwd,
              });
      } catch (error) {
        asked = Promise.resolve({ accepted: false, reason: reasonOf(error) });
      }
      void asked.then(
        (outcome) => answer(pane.id, id, pane.sessionId, request, outcome),
        (error: unknown) => answer(pane.id, id, pane.sessionId, request, { accepted: false, reason: reasonOf(error) }),
      );
    },
    [advance, answer, release],
  );

  /** The mark is home (the launcher's shell is done with) or back in its row (the launcher is yours again). */
  const settleLaunch = useCallback(
    (paneId: string, id: string, outcome: PaneLaunchOutcome): void => {
      const record = launchesRef.current.get(paneId);
      release(id);
      if (!record || record.id !== id) return;
      inFlight.current.delete(paneId);
      setLaunches((current) => {
        if (current.get(paneId)?.id !== id) return current;
        const next = new Map(current);
        next.delete(paneId);
        return next;
      });
      if (outcome === 'landed') dismiss(record.freshSessionId);
    },
    [dismiss, release],
  );
  /** The host says this shell has input now: its launcher goes (the host needs no telling). */
  const recheck = useCallback((sessionId: string): boolean => {
    if (callbacks.current.hasInput?.(sessionId) !== true) return false;
    setUsed((current) => addTo(current, sessionId));
    return true;
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
    const rechecks = new Set<number>();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.target instanceof Node)) return;
      const route = launcherPaneForTarget(event.target, routes.current);
      if (!route) return;
      const controller = controllers.current.get(route.paneId);
      if (!controller) return;
      const decision = launcherKeyDecision(
        event,
        controller.keyState(),
        callbacks.current.hasInput?.(route.sessionId) === true,
      );
      if (decision.consume) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (decision.release) releases.took(event.code);
      }
      switch (decision.effect) {
        case 'none':
          if (decision.action.kind === 'ignore' && (event.metaKey || event.ctrlKey)) {
            const sessionId = route.sessionId;
            const timer = window.setTimeout(() => {
              rechecks.delete(timer);
              recheck(sessionId);
            }, LAUNCHER_INPUT_RECHECK_MS);
            rechecks.add(timer);
          }
          return;
        case 'used':
          if (!recheck(route.sessionId)) markUsed(route.sessionId);
          return;
        case 'dismiss':
          dismiss(route.sessionId);
          return;
        case 'apply':
          controller.apply(decision.action);
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (releases.released(event.code)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const route = event.target instanceof Node ? launcherPaneForTarget(event.target, routes.current) : undefined;
      if (route) recheck(route.sessionId);
    };
    const onPointerDown = (event: PointerEvent): void => {
      const route = event.target instanceof Node ? launcherPaneForTarget(event.target, routes.current) : undefined;
      if (route) recheck(route.sessionId);
    };
    const onFocus = (): void => {
      for (const route of routes.current) recheck(route.sessionId);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('focus', onFocus);
      for (const timer of rechecks) window.clearTimeout(timer);
    };
  }, [markUsed, dismiss, recheck]);

  // The panes as they are now. A pane that went away takes its launch and its
  // line with it. A launch whose born session has left its pane before it drew
  // (an agent that exited at once, its pane given a fresh shell again) lets
  // the pane go at once, and the launcher there now says so; until the port
  // names the session, the pane's session is the host's business (it may
  // mount the agent before it answers, or after).
  const paneSessions = paneSessionsKey(panes);
  useEffect(() => {
    const sessionIn = paneSessionsOf(paneSessions);
    for (const [paneId, record] of launches) {
      const now = sessionIn.get(paneId);
      if (now === undefined) {
        release(record.id);
        inFlight.current.delete(paneId);
        setLaunches((current) => {
          if (!current.has(paneId)) return current;
          const next = new Map(current);
          next.delete(paneId);
          return next;
        });
        continue;
      }
      const { running, sessionId } = record.state;
      if (launchSettled(record.state) || !running || sessionId === undefined) continue;
      if (now === sessionId || now === record.freshSessionId) continue;
      release(record.id);
      inFlight.current.delete(paneId);
      const line = leftLine(record);
      setRefusals((current) => new Map(current).set(paneId, { sessionId: now, line }));
      advance(paneId, record.id, { type: 'left' });
    }
    setRefusals((current) => {
      const gone = [...current.keys()].filter((paneId) => !sessionIn.has(paneId));
      if (gone.length === 0) return current;
      const next = new Map(current);
      for (const paneId of gone) next.delete(paneId);
      return next;
    });
  }, [paneSessions, launches, advance, release]);

  // Unmounted, every launch lets go of its timers and its watch.
  useEffect(
    () => () => {
      for (const id of [...jobs.current.keys()]) release(id);
    },
    [release],
  );

  /** The launch in `paneId`, as its launcher draws it, while that launcher's shell is the one it replaces. */
  const launchOf = (paneId: string, sessionId: string) => {
    const record = launches.get(paneId);
    if (!record || record.freshSessionId !== sessionId) return undefined;
    return { verb: record.verb, index: record.index, returning: record.state.phase === 'refused' };
  };

  return (
    <>
      {[...launches.values()].map((record) => {
        const element = elements.byId.get(record.paneId);
        if (!element) return null;
        const color = paneColors.get(record.paneId);
        return (
          <PaneLaunch
            key={`${record.paneId}\n${record.id}`}
            pane={element}
            launchId={record.id}
            verb={record.verb}
            {...(record.providerId ? { providerId: record.providerId } : {})}
            label={record.label}
            {...(color ? { color } : {})}
            from={record.from}
            source={launchSource(record.verb, record.index)}
            startedAt={record.startedAt}
            state={record.state}
            onSettled={(outcome) => settleLaunch(record.paneId, record.id, outcome)}
            {...(reducedMotion !== undefined ? { reducedMotion } : {})}
          />
        );
      })}
      {shown.map((pane) => {
        const element = elements.byId.get(pane.id);
        if (!element) return null;
        const sessionId = pane.session.id;
        const cwd = cwdBySession.get(sessionId) ?? pane.session.cwd ?? undefined;
        const color = paneColors.get(pane.id);
        const refusal = refusals.get(pane.id);
        const failure = refusal?.sessionId === sessionId ? refusal.line : undefined;
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
            onLaunch={(request) => startLaunch({ id: pane.id, sessionId, cwd }, request)}
            {...(launchOf(pane.id, sessionId) ? { launch: launchOf(pane.id, sessionId) } : {})}
            {...(failure ? { failure } : {})}
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
