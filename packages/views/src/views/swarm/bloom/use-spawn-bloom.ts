import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type { MonitorSpawnMenu, MonitorSpawnTarget } from '@vibecook/puppeteer-view-sdk';
import { approximateBloomMeasure, canvasBloomMeasure } from './canvas-measure.js';
import { BLOOM, type BloomTextMeasure } from './constants.js';
import type { BloomPoint, BloomRect, BloomSize } from './geometry.js';
import {
  cancelBloom,
  commitBloom,
  isInstant,
  keyBloom,
  keysOrigin,
  openBloom,
  pointBloom,
  type BloomBody,
  type BloomChoice,
  type BloomCommit,
  type BloomEnv,
  type BloomState,
} from './model.js';
import type { BloomMode } from './words.js';

// AgentSwarm's half of the spawn bloom (SB): the machine's state, the pointer
// and the keys routed into it, the focus it takes and gives back, and the hub
// the field draws. AgentSwarm owns the pointer's capture and hands each event
// here first; a method that answers true took the event. Without a spawn menu
// nothing here engages and a completed hold creates at once, exactly as before.
//
// On the SDK (MV-5) the bloom reads no document and binds no global key
// (MV-W2, MV-D8). Where the keyboard's focus stands it learns from the view's
// own focus events (`SpawnBloomHost.focus`); what had the focus when a bloom
// took it, from the focus event that brought it (`focusEntered`); and a hold's
// ⎋ it hears on the field, which is focusable for exactly that (`fieldKeyDown`).

/**
 * Where the keyboard's focus stands, as the swarm tracks it from its own focus
 * events: in the bloom's menu, on the field itself, on one of the view's
 * controls (a body's button, the keys door), outside the view, or nowhere the
 * view has seen it go.
 */
export type BloomFocusPlace = 'menu' | 'field' | 'control' | 'outside' | 'none';

/** What the bloom reads from the swarm it lives in. */
export interface SpawnBloomHost {
  /** The field's element: its size, and the frame of every point handed in. */
  readonly container: RefObject<HTMLElement | null>;
  /** The chrome over the field (the stage's obstacles, MV-D19: what the physics already keeps off). */
  readonly readChrome: () => readonly BloomRect[];
  /** The bodies drawn now, for where the words go. */
  readonly bodies: () => readonly BloomBody[];
  /** An idle body's radius: a chosen bud grows to it. */
  readonly idleRadius: () => number;
  /** Motion is on: no reduced-motion preference and the host's animations switch on. */
  readonly motion: () => boolean;
  /** Where the focus stands now, from the view's own focus events. */
  readonly focus: () => BloomFocusPlace;
  /** The view's `create`: where, and the desktop and profile chosen. A host that answers with a promise is waited
   * for (the birth's clock, SB §2.6); one that answers nothing counts as answered at once. */
  readonly createAt: (at: BloomPoint, target?: MonitorSpawnTarget) => void | Promise<void>;
  /** A bloom's commit asked the host for a terminal (not an instant create): the swarm draws the
   * birth until its row arrives. `answer` settles as `createAt` did (a throw is a rejection). */
  readonly born?: ((choice: BloomChoice, answer: Promise<void>) => void) | undefined;
}

/** The frame's hub: the hold ring frozen at full size while the bloom is open, fading once it closes. */
export interface SpawnBloomHub {
  readonly x: number;
  readonly y: number;
  readonly progress: number;
  readonly frozen: true;
  readonly opacity: number;
}

/** The bloom's controls. Stable for the swarm's life; `state` and `reduced` are this render's. */
export interface SpawnBloomControl {
  /** The bloom as the overlay draws it (open, or closed and playing its exit). */
  readonly state: BloomState | null;
  readonly reduced: boolean;
  readonly menuRef: RefObject<HTMLDivElement | null>;
  /** A bloom is open and takes the pointer. */
  isOpen(): boolean;
  /** A hold completed: bloom there, or create at once when there is nothing to choose. */
  held(point: BloomPoint, pointerId: number): void;
  pointerDown(event: ReactPointerEvent<HTMLElement>, point: BloomPoint | undefined): boolean;
  pointerMove(event: ReactPointerEvent<HTMLElement>, point: BloomPoint | undefined): boolean;
  pointerUp(event: ReactPointerEvent<HTMLElement>, point: BloomPoint | undefined): boolean;
  /** The hold's pointer was cancelled or lost its capture: the bloom goes. */
  pointerCancel(event: ReactPointerEvent<HTMLElement>): boolean;
  contextMenu(event: ReactMouseEvent<HTMLElement>, point: BloomPoint | undefined, onBody: boolean): void;
  /** The keys door: a bloom at the field's middle, a little low, with the keyboard in it. */
  openKeys(returnTo: HTMLElement | null): void;
  /** Put an open bloom away (nothing opens). */
  cancel(): void;
  /** The hub for the frame at `time` (the render loop's clock). */
  hub(time: number): SpawnBloomHub | undefined;
  /** The bloom now, and when it closed (the render loop's clock), for the field under it. */
  field(): { readonly state: BloomState | null; readonly closedAt: number };
  onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void;
  onBlur(event: ReactFocusEvent<HTMLDivElement>): void;
  /** A key on the field itself (MV-D8): ⎋ puts a hold's bloom away. True when the key was taken. */
  fieldKeyDown(event: ReactKeyboardEvent<HTMLElement>): boolean;
  /** The menu took the focus: what had it (the focus event's `relatedTarget`) is where it goes back to. */
  focusEntered(related: EventTarget | null): void;
}

/** What a choice asks the host for; nothing when it names neither a desktop nor a profile (today's call). */
export function spawnTarget(choice: Pick<BloomChoice, 'deviceId' | 'profileSet'>): MonitorSpawnTarget | undefined {
  if (choice.deviceId === undefined && choice.profileSet === undefined) return undefined;
  return { deviceId: choice.deviceId, profileSet: choice.profileSet };
}

/** Ask the host for a terminal and never leave its failure unhandled: a host that cannot open one
 * says why itself (VibeField announces, then rejects), so a rejection — or a throw, which becomes
 * one — is caught here. The answer is returned for whoever still wants to know how it ended. */
export function createQuietly(run: () => void | Promise<void>): Promise<void> {
  let answer: void | Promise<void>;
  try {
    answer = run();
  } catch (error) {
    answer = Promise.reject(error);
  }
  const settled = Promise.resolve(answer);
  settled.catch(() => undefined);
  return settled;
}

/** How long a closed bloom stays for its exit: the buds home, the words' hold and their step out. */
export function bloomExitMs(state: BloomState, motionScale = 1): number {
  const closed = state.closed;
  if (!closed) return 0;
  return Math.max(closed.retract + BLOOM.pop * motionScale + 60, closed.sayHold + 260);
}

interface Memory {
  state: BloomState | null;
  /** The pointer a hold's bloom follows. */
  pointer: number | undefined;
  /** The field and its chrome as they were when the bloom opened: they do not move under it. */
  field: BloomSize;
  chrome: readonly BloomRect[];
  reduced: boolean;
  measure: BloomTextMeasure | undefined;
  closedAt: number;
  exitTimer: ReturnType<typeof setTimeout> | undefined;
  /** Where the keyboard goes back to when a held-open or keys bloom closes; `pending`: whatever the menu takes it
   * from, learned when it does (`focusEntered`). */
  returnFocus: HTMLElement | null | 'pending';
  /** The focus already went somewhere of its own accord (Tab, a click elsewhere): leave it there. */
  keepFocus: boolean;
  /** A secondary press just put the bloom away: its contextmenu must not open another. */
  suppressContext: boolean;
}

/** The bloom's controls without React: what the hook wraps, and what a test drives. */
export interface SpawnBloomEngine extends Omit<SpawnBloomControl, 'state' | 'reduced'> {
  /** The bloom now (the hook's render lags it by a React commit). */
  current(): BloomState | null;
  /** Forget the bloom at once (the host stopped offering a menu). */
  drop(): void;
  /** The swarm is going: stop every timer. */
  dispose(): void;
}

/** `host` and `menu` are read at every event (a hook hands in refs it keeps current); `render`
 * hears every new state, and whether it is drawn under reduced motion. */
export function createSpawnBloomEngine(
  host: { readonly current: SpawnBloomHost },
  menuOfHost: { readonly current: MonitorSpawnMenu | undefined },
  menuRef: RefObject<HTMLDivElement | null>,
  render: (state: BloomState | null, reduced: boolean) => void,
): SpawnBloomEngine {
  const m: Memory = {
    state: null,
    pointer: undefined,
    field: { w: 0, h: 0 },
    chrome: [],
    reduced: false,
    measure: undefined,
    closedAt: 0,
    exitTimer: undefined,
    returnFocus: null,
    keepFocus: false,
    suppressContext: false,
  };

  const env = (): BloomEnv => {
    const element = host.current.container.current;
    m.measure ??= (element ? canvasBloomMeasure(element) : undefined) ?? approximateBloomMeasure;
    return {
      field: m.field,
      chrome: m.chrome,
      measure: m.measure,
      now: performance.now(),
      reduced: m.reduced,
      bodies: host.current.bodies(),
      idleRadius: host.current.idleRadius(),
    };
  };

  const open = (): BloomState | null => (m.state && !m.state.closed ? m.state : null);

  /** The keyboard goes back where it came from, once the press that closed the bloom has moved it (or not). */
  const giveBackFocus = (): void => {
    const target = m.returnFocus === 'pending' ? null : m.returnFocus;
    m.returnFocus = null;
    if (m.keepFocus) {
      m.keepFocus = false;
      return;
    }
    setTimeout(() => {
      // Adrift: still in the menu, on the field itself (a press on empty ground), or nowhere the view has seen.
      const where = host.current.focus();
      const adrift = where === 'menu' || where === 'field' || where === 'none';
      if (!adrift) return;
      if (target?.isConnected) target.focus({ preventScroll: true });
      else menuRef.current?.blur();
    }, 0);
  };

  const set = (next: BloomState | null): void => {
    const prev = m.state;
    if (next === prev) return;
    m.state = next;
    render(next, m.reduced);
    if (!next) {
      clearTimeout(m.exitTimer);
      m.exitTimer = undefined;
      return;
    }
    if (!next.closed || (prev?.closed && prev.startedAt === next.startedAt)) return;
    // Closed: the hub shrinks from now, and the bloom is dropped once its exit has run.
    m.closedAt = performance.now();
    clearTimeout(m.exitTimer);
    m.exitTimer = setTimeout(() => {
      m.exitTimer = undefined;
      if (m.state === next) set(null);
    }, bloomExitMs(next));
    if (next.mode !== 'hold') giveBackFocus();
  };

  const create = (choice: BloomChoice): Promise<void> => {
    const at = { x: choice.at.x, y: choice.at.y };
    const target = spawnTarget(choice);
    return createQuietly(() => (target ? host.current.createAt(at, target) : host.current.createAt(at)));
  };

  const finish = (commit: BloomCommit): void => {
    set(commit.state);
    if (!commit.choice) return;
    const answer = create(commit.choice);
    host.current.born?.(commit.choice, answer);
  };

  const cancel = (): void => {
    const s = open();
    if (s) set(cancelBloom(env(), s));
  };

  const commitAt = (point: BloomPoint | undefined): void => {
    const s = open();
    if (!s) return;
    const e = env();
    finish(commitBloom(e, point ? pointBloom(e, s, point) : s));
  };

  /** A bloom at `P`: true when it opened, false when the menu had nothing to choose (created at once). */
  const bloomAt = (P: BloomPoint, mode: BloomMode, menu: MonitorSpawnMenu): boolean => {
    const element = host.current.container.current;
    m.field = { w: element?.clientWidth ?? 0, h: element?.clientHeight ?? 0 };
    m.chrome = host.current.readChrome();
    m.reduced = !host.current.motion();
    const opened = openBloom(env(), P, mode, menu);
    if (isInstant(opened)) {
      void create(opened.instant);
      return false;
    }
    m.keepFocus = false;
    set(opened);
    return true;
  };

  return {
    menuRef,
    isOpen: () => open() !== null,
    held(point, pointerId) {
      const menu = menuOfHost.current;
      if (!menu) {
        void createQuietly(() => host.current.createAt({ x: point.x, y: point.y }));
        return;
      }
      m.pointer = pointerId;
      bloomAt(point, 'hold', menu);
    },
    pointerDown(event, point) {
      m.suppressContext = false;
      const s = open();
      if (!s) return false;
      // a hold's bloom has its pointer; another press changes nothing
      if (s.mode === 'hold') return true;
      // held open: a primary click commits what it points at, any other button puts it away
      event.preventDefault();
      if (event.button !== 0) {
        if (event.button === 2) m.suppressContext = true;
        cancel();
        return true;
      }
      commitAt(point);
      return true;
    },
    pointerMove(event, point) {
      const s = open();
      if (!s) return false;
      if (s.mode === 'hold' && event.pointerId !== m.pointer) return true;
      if (point) set(pointBloom(env(), s, point));
      return true;
    },
    pointerUp(event, point) {
      const s = open();
      if (!s) return false;
      // held open, the press committed; a hold commits where it lets go
      if (s.mode === 'hold' && event.pointerId === m.pointer) commitAt(point);
      return true;
    },
    pointerCancel(event) {
      const s = open();
      if (!s || s.mode !== 'hold' || event.pointerId !== m.pointer) return false;
      cancel();
      return true;
    },
    contextMenu(event, point, onBody) {
      const menu = menuOfHost.current;
      if (!menu) return;
      event.preventDefault();
      if (m.suppressContext) {
        m.suppressContext = false;
        return;
      }
      if (open()) {
        cancel();
        return;
      }
      if (!point || onBody) return;
      // Whatever has the keyboard gets it back when this bloom closes: learned as the menu takes it.
      m.returnFocus = 'pending';
      if (!bloomAt(point, 'sticky', menu)) m.returnFocus = null;
    },
    openKeys(returnTo) {
      const menu = menuOfHost.current;
      if (!menu || open()) return;
      const element = host.current.container.current;
      const origin = keysOrigin({ w: element?.clientWidth ?? 0, h: element?.clientHeight ?? 0 });
      m.returnFocus = returnTo;
      if (!bloomAt(origin, 'keys', menu)) m.returnFocus = null;
    },
    cancel,
    hub(time) {
      const s = m.state;
      if (!s) return undefined;
      if (!s.closed) return { x: s.P.x, y: s.P.y, progress: 1, frozen: true, opacity: 1 };
      const k = (time - m.closedAt) / Math.max(1, s.closed.retract);
      if (k >= 1) return undefined;
      return { x: s.P.x, y: s.P.y, progress: 1, frozen: true, opacity: Math.min(1, 1 - k) };
    },
    onKeyDown(event) {
      const s = open();
      if (!s) return;
      // the bloom holds the keys while it is open
      event.stopPropagation();
      if (event.key === 'Tab') {
        // the menu pattern: Tab puts it away and the focus moves on
        m.keepFocus = true;
        set(cancelBloom(env(), s));
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const result = keyBloom(env(), s, event.key);
      if (result.handled) event.preventDefault();
      if (result.commit) finish(result.commit);
      else set(result.state);
    },
    onBlur(event) {
      const s = open();
      if (!s || s.mode === 'hold') return;
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      // the keyboard went elsewhere: put the bloom away and leave the focus where it went
      m.keepFocus = true;
      set(cancelBloom(env(), s));
    },
    fieldKeyDown(event) {
      // Esc during a hold: the pointer is down on the field and the keyboard is on the field with it.
      if (event.key !== 'Escape') return false;
      const s = open();
      if (!s || s.mode !== 'hold') return false;
      event.preventDefault();
      event.stopPropagation();
      cancel();
      return true;
    },
    focusEntered(related) {
      if (m.returnFocus !== 'pending') return;
      m.returnFocus = typeof HTMLElement !== 'undefined' && related instanceof HTMLElement ? related : null;
    },
    field: () => ({ state: m.state, closedAt: m.closedAt }),
    current: () => m.state,
    drop() {
      m.returnFocus = null;
      set(null);
    },
    dispose() {
      clearTimeout(m.exitTimer);
      m.exitTimer = undefined;
    },
  };
}

export function useSpawnBloom(spawnMenu: MonitorSpawnMenu | undefined, host: SpawnBloomHost): SpawnBloomControl {
  const [shown, setShown] = useState<{ state: BloomState | null; reduced: boolean }>({ state: null, reduced: false });
  const menuRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef(host);
  hostRef.current = host;
  const menuOfHost = useRef(spawnMenu);
  menuOfHost.current = spawnMenu;
  const engine = useRef<SpawnBloomEngine | null>(null);
  engine.current ??= createSpawnBloomEngine(hostRef, menuOfHost, menuRef, (state, reduced) =>
    setShown({ state, reduced }),
  );
  const { state } = shown;

  // Held open or from the keys door, the bloom takes the keyboard.
  useLayoutEffect(() => {
    if (!state || state.closed || state.mode === 'hold') return;
    const menu = menuRef.current;
    if (menu && hostRef.current.focus() !== 'menu') menu.focus({ preventScroll: true });
  }, [state]);

  // A host that stops offering a menu takes the bloom with it.
  useEffect(() => {
    if (!spawnMenu) engine.current?.drop();
  }, [spawnMenu]);

  useEffect(() => () => engine.current?.dispose(), []);

  return { ...engine.current, state, reduced: shown.reduced };
}
