import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEventHandler,
  type KeyboardEventHandler,
  type ReactElement,
  type RefObject,
} from 'react';
import { ProfileGlyph } from '@vibefield/puppeteer-view-sdk/react';
import { BLOOM } from './constants.js';
import type { BloomBox } from './geometry.js';
import { bloomView, type BloomBudView, type BloomSay, type BloomState, type BloomView } from './model.js';
import type { BloomTarget } from './targeting.js';

// The spawn bloom's overlay (SB, thinking-spawn-bloom §2): the DOM a swarm
// draws over its field while a hold, a secondary click or the keys door holds
// a bloom open — the buds, their seated labels, the tether and THE WORDS. It
// renders what the core derives (`bloomView`) and reads no pointer: the layer
// is `pointer-events: none`, and AgentSwarm keeps the pointer's capture and
// routes it through the core. Every motion is a CSS transition (DESIGN §6 M3)
// set off by the classes this component moves between, as the prototype's
// controller did with class lists and timers (draft/spawn-bloom/bloom.js).
//
// What that controller remembered lives here as a STAGE, derived while
// rendering so a bud or a slate that leaves keeps its DOM element (its exit is
// a transition of that element, never a new one): which buds have left the
// hub, which left the view while the bloom stayed up (a collapsed second ring,
// going home along its spokes), which labels are stepping to a new seat, and
// which slates of words are stepping out. Only the clock is an effect.

/** A label that must move steps out where it was for this long, then in where it goes. */
const LABEL_STEP_MS = 100;
/** A slate stepping out is removed after this. */
const SLATE_GONE_MS = 240;
/** A bud that left the view is removed this long after its retract has run. */
const RETRACT_TAIL_MS = 40;

/** A label as it is painted: where, and whether it is the name alone or gone. */
interface Seat {
  readonly box: BloomBox;
  readonly short: boolean;
  readonly gone: boolean;
}

/** A label stepping out from `seat`; a new move while it steps restarts the step (`gen`). */
interface Step {
  readonly seat: Seat;
  readonly gen: number;
}

interface Slate {
  readonly key: string;
  readonly say: BloomSay;
}

interface Stage {
  /** The bloom this stage was derived for. */
  readonly state: BloomState | null;
  readonly view: BloomView | null;
  /** Buds that have left the hub (`is-out`). */
  readonly out: ReadonlySet<string>;
  /** Buds that left the view while the bloom stayed up: home along their spokes, then gone. */
  readonly ghosts: readonly BloomBudView[];
  readonly steps: ReadonlyMap<string, Step>;
  /** Earlier slates of words, stepping out. */
  readonly retiring: readonly Slate[];
  /** The slate stepping in (until the next frame). */
  readonly entering: string | null;
  /** Slates whose time is up: after a commit, "Opening …" leaves once `sayHold` has passed. */
  readonly retired: ReadonlySet<string>;
}

const NOTHING: ReadonlySet<string> = new Set();

const IDLE: Stage = {
  state: null,
  view: null,
  out: NOTHING,
  ghosts: [],
  steps: new Map(),
  retiring: [],
  entering: null,
  retired: NOTHING,
};

export interface SpawnBloomProps {
  /** The bloom, open or closed and playing its exit (a host keeps a closed bloom
   * until its exit has run: the buds' retract, the words' `sayHold`). Null: none. */
  readonly state: BloomState | null;
  /** Drawn at rest: every bud already out, no entrances and no steps (tests, the lab, a catalog). */
  readonly posed?: boolean | undefined;
  /** Reduced motion as the host reads it (the preference, or its animations switch): labels
   * move without stepping. The CSS fades on its own under `prefers-reduced-motion` and
   * `.vf-godview[data-godview-animations='off']`; this class covers a host with neither. */
  readonly reduced?: boolean | undefined;
  /** Scales the bloom's own durations (the core's `motionScale`); 1 by default. */
  readonly motionScale?: number | undefined;
  /** The `role="menu"` element: the keys door and a bloom held open move focus to it. */
  // Structural on purpose: `Ref`'s callback form is nominal per copy of @types/react, and a host
  // compiling these sources against two copies (VibeField) cannot hand one to the other's JSX `ref`.
  readonly menuRef?: RefObject<HTMLDivElement | null> | undefined;
  /** Keys while the menu holds the focus (the host routes them through `keyBloom`). */
  readonly onKeyDown?: KeyboardEventHandler<HTMLDivElement> | undefined;
  readonly onBlur?: FocusEventHandler<HTMLDivElement> | undefined;
}

/** What letting go does now, as the DOM names it (`data-bloom-target`):
 * `hub` · `none` · `device:<id>` · `profile:<id>`. */
export function bloomTargetWord(target: BloomTarget | null | undefined): string {
  if (!target) return 'none';
  if (target.kind === 'hub' || target.kind === 'none') return target.kind;
  return target.kind === 'device' ? `device:${target.item.device.id}` : `profile:${target.item.profile.id}`;
}

function seatOf(bud: BloomBudView): Seat {
  return { box: bud.box, short: bud.short, gone: bud.gone };
}

function slateKey(state: BloomState, say: BloomSay): string {
  return `${state.startedAt}:${say.slate}`;
}

/** Reading layout commits the styles a new element starts from, so the class
 * that follows transitions from them rather than jumping there. */
function reflow(element: Element | null): void {
  void element?.getBoundingClientRect();
}

/** The next stage for a new bloom state: what left, what moved, which words changed. Pure.
 * Posed, nothing moves: the stage is only the state. */
function advance(
  stage: Stage,
  state: BloomState | null,
  view: BloomView | null,
  motion: { readonly posed: boolean; readonly reduced: boolean },
): Stage {
  if (!state || !view) return IDLE;
  if (motion.posed) return { ...IDLE, state, view };
  const prev = stage.view;
  const ids = new Set(view.buds.map((bud) => bud.id));
  const ghosts = [
    ...stage.ghosts.filter((ghost) => !ids.has(ghost.id)),
    ...(prev?.buds ?? []).filter((bud) => !ids.has(bud.id)),
  ];
  // A label whose seat moved while it was shown steps out where it is painted
  // and in where it goes; the prototype's `reseat`.
  const steps = new Map<string, Step>();
  if (prev) {
    const before = new Map(prev.buds.map((bud) => [bud.id, bud] as const));
    for (const bud of view.buds) {
      const was = before.get(bud.id);
      if (!was) continue;
      const step = stage.steps.get(bud.id);
      const shown = !motion.reduced && prev.open && view.open && !was.gone && !bud.gone && stage.out.has(bud.id);
      if (!shown) continue;
      const moved = was.box.x !== bud.box.x || was.box.y !== bud.box.y || was.box.h !== bud.box.h;
      if (moved) steps.set(bud.id, { seat: step?.seat ?? seatOf(was), gen: (step?.gen ?? 0) + 1 });
      else if (step) steps.set(bud.id, step);
    }
  }
  const key = view.say ? slateKey(state, view.say) : null;
  const prevKey = stage.state && prev?.say ? slateKey(stage.state, prev.say) : null;
  let retiring = stage.retiring.filter((slate) => slate.key !== key);
  let entering = stage.entering;
  if (key !== prevKey) {
    if (prevKey && prev?.say && !retiring.some((slate) => slate.key === prevKey)) {
      retiring = [...retiring, { key: prevKey, say: prev.say }];
    }
    entering = key;
  }
  return { ...stage, state, view, ghosts, steps, retiring, entering };
}

function budStyle(bud: BloomBudView, delay: number, grow: number | null): CSSProperties {
  const half = bud.d / 2;
  const px = (value: number): string => `${Math.round(value * 100) / 100}px`;
  return {
    '--mv-swarm-bloom-d': px(bud.d),
    '--mv-swarm-bloom-hx': px(bud.hx - half),
    '--mv-swarm-bloom-hy': px(bud.hy - half),
    '--mv-swarm-bloom-tx': px(bud.x - half),
    '--mv-swarm-bloom-ty': px(bud.y - half),
    '--mv-swarm-bloom-delay': `${Math.round(delay)}ms`,
    '--mv-swarm-bloom-lean': bud.lean.toFixed(3),
    ...(grow === null ? {} : { '--mv-swarm-bloom-grow': grow.toFixed(2) }),
  } as CSSProperties;
}

function BudFace({ bud }: { bud: BloomBudView }): ReactElement {
  const face = bud.face;
  return (
    <span className="vf-bloom-face">
      {face.kind === 'initial' ? (
        <b>{face.text}</b>
      ) : (
        <ProfileGlyph
          kind={face.glyph === 'laptop' ? 'native' : 'managed'}
          glyph={face.glyph === 'laptop' ? undefined : face.glyph}
          filled={face.filled}
          size={bud.level === 1 ? 20 : 18}
        />
      )}
      {bud.dot ? <i className="vf-bloom-dot" /> : null}
    </span>
  );
}

function SlateView({ say, stepping }: { say: BloomSay; stepping: 'in' | 'out' | null }): ReactElement {
  const words = say.words;
  return (
    <div
      className={`vf-bloom-say${stepping ? ` is-${stepping}` : ''}${say.m.twoLine ? ' is-two' : ''}`}
      data-align={say.align}
      data-tone={words.tone}
      data-bloom-words={words.parts.map((part) => part[0]).join('')}
      data-bloom-slate={say.slate}
      aria-hidden={stepping === 'out' ? true : undefined}
      style={{ left: say.x, top: say.y, width: say.m.w, '--mv-swarm-bloom-say': `${say.m.size}px` } as CSSProperties}
    >
      <div className="vf-bloom-say-line">
        {words.parts.map(([text, role], index) => (
          <span key={index} className={role === 'n' ? 'n' : 'v'}>
            {text}
          </span>
        ))}
      </div>
      {words.detail ? <div className="vf-bloom-say-detail">{words.detail}</div> : null}
    </div>
  );
}

export function SpawnBloom({
  state,
  posed = false,
  reduced = false,
  motionScale = 1,
  menuRef,
  onKeyDown,
  onBlur,
}: SpawnBloomProps): ReactElement {
  const derived = useMemo(() => (state ? bloomView(state) : null), [state]);
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [kept, setStage] = useState<Stage>(IDLE);
  // A new bloom state: derive the next stage now, in this render (React
  // re-renders at once), so what leaves is still here to leave.
  let stage = kept;
  if (kept.state !== state) {
    stage = advance(kept, state, derived, { posed, reduced });
    setStage(stage);
  }

  const timers = useRef(new Set<number>());
  const frames = useRef(new Set<number>());
  /** What the clock already waits on: ghosts, slates, entrances, steps, the close's hold. */
  const booked = useRef({
    out: new Set<string>(),
    ghosts: new Set<string>(),
    retiring: new Set<string>(),
    entering: new Set<string>(),
    closes: new Set<string>(),
    steps: new Map<string, { gen: number; timer: number }>(),
  });

  const later = (ms: number, run: () => void): number => {
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      run();
    }, ms);
    timers.current.add(timer);
    return timer;
  };
  const nextFrame = (run: () => void): void => {
    const frame = window.requestAnimationFrame(() => {
      frames.current.delete(frame);
      run();
    });
    frames.current.add(frame);
  };
  const forget = (): void => {
    for (const timer of timers.current) window.clearTimeout(timer);
    for (const frame of frames.current) window.cancelAnimationFrame(frame);
    timers.current.clear();
    frames.current.clear();
    const book = booked.current;
    book.out.clear();
    book.ghosts.clear();
    book.retiring.clear();
    book.entering.clear();
    book.closes.clear();
    book.steps.clear();
  };

  useLayoutEffect(() => forget, []);

  // The clock: everything the stage waits on, booked once it is on screen.
  useLayoutEffect(() => {
    const onScreen = kept;
    if (!onScreen.state || !onScreen.view) {
      forget();
      return;
    }
    if (posed) return;
    const view = onScreen.view;
    const book = booked.current;
    const scale = motionScale;
    // Buds new to the view leave the hub on the next frame.
    const fresh = view.open
      ? view.buds.filter((bud) => !onScreen.out.has(bud.id) && !book.out.has(bud.id)).map((bud) => bud.id)
      : [];
    if (fresh.length) {
      for (const id of fresh) book.out.add(id);
      reflow(rootRef.current);
      nextFrame(() => setStage((s) => (s.state ? { ...s, out: new Set([...s.out, ...fresh]) } : s)));
    }
    for (const ghost of onScreen.ghosts) {
      if (book.ghosts.has(ghost.id)) continue;
      book.ghosts.add(ghost.id);
      later(ghost.delay + BLOOM.retract * scale + RETRACT_TAIL_MS, () => {
        book.ghosts.delete(ghost.id);
        setStage((s) => ({ ...s, ghosts: s.ghosts.filter((g) => g.id !== ghost.id) }));
      });
    }
    for (const slate of onScreen.retiring) {
      if (book.retiring.has(slate.key)) continue;
      book.retiring.add(slate.key);
      later(SLATE_GONE_MS, () => {
        book.retiring.delete(slate.key);
        setStage((s) => ({ ...s, retiring: s.retiring.filter((r) => r.key !== slate.key) }));
      });
    }
    const entering = onScreen.entering;
    if (entering && !book.entering.has(entering)) {
      book.entering.add(entering);
      reflow(rootRef.current);
      nextFrame(() => setStage((s) => (s.entering === entering ? { ...s, entering: null } : s)));
    }
    for (const [id, step] of onScreen.steps) {
      const booking = book.steps.get(id);
      if (booking?.gen === step.gen) continue;
      if (booking) window.clearTimeout(booking.timer);
      const timer = later(LABEL_STEP_MS * scale, () => {
        book.steps.delete(id);
        setStage((s) => {
          if (s.steps.get(id)?.gen !== step.gen) return s;
          const steps = new Map(s.steps);
          steps.delete(id);
          return { ...s, steps };
        });
      });
      book.steps.set(id, { gen: step.gen, timer });
    }
    for (const [id, booking] of book.steps) {
      if (onScreen.steps.has(id)) continue;
      window.clearTimeout(booking.timer);
      book.steps.delete(id);
    }
    // After a commit the words stay ("Opening …") while the birth begins, then leave.
    const closed = view.closed;
    const say = view.say;
    if (closed && say) {
      const key = slateKey(onScreen.state, say);
      if (!book.closes.has(key)) {
        book.closes.add(key);
        later(closed.sayHold, () => setStage((s) => ({ ...s, retired: new Set([...s.retired, key]) })));
      }
    }
  }, [kept, posed, motionScale]);

  const scale = motionScale;
  const rootStyle = {
    '--mv-swarm-bloom-pop': `${Math.round(BLOOM.pop * scale)}ms`,
    '--mv-swarm-bloom-lift': `${Math.round(BLOOM.lift * scale)}ms`,
    '--mv-swarm-bloom-retract': `${Math.round(BLOOM.retract * scale)}ms`,
  } as CSSProperties;

  const current = stage.state && stage.view ? { state: stage.state, view: stage.view } : null;
  if (!current) {
    // The live region stays in the document between blooms, so the first words of the next are heard.
    return (
      <div ref={rootRef} className="vf-bloom" data-bloom-state="idle" style={rootStyle}>
        <div className="vf-bloom-say-root" aria-live="polite" />
      </div>
    );
  }

  const { view } = current;
  const closed = view.closed;
  const domId = (id: string): string => `${uid}-${id}`;
  const isOut = (bud: BloomBudView): boolean => posed || stage.out.has(bud.id);
  const buds = [
    ...view.buds.map((bud) => ({ bud, ghost: false })),
    ...stage.ghosts.map((bud) => ({ bud, ghost: true })),
  ];
  const sayKey = view.say ? slateKey(current.state, view.say) : null;
  const holdsKeys = view.open && (view.mode === 'keys' || view.mode === 'sticky');
  const tether = view.tether;

  return (
    <div
      ref={rootRef}
      className={`vf-bloom${view.open ? ' is-open' : ''}${reduced ? ' is-reduced' : ''}`}
      data-bloom-state={view.open ? 'open' : closed?.reason === 'commit' ? 'committed' : 'cancelled'}
      data-bloom-level={view.level}
      data-bloom-mode={view.mode}
      data-bloom-target={bloomTargetWord(current.state.target)}
      style={rootStyle}
    >
      <svg className="vf-bloom-lines" aria-hidden="true">
        {tether ? (
          <path
            className="vf-bloom-tether"
            d={tether.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')}
          />
        ) : null}
      </svg>
      <div
        ref={menuRef}
        className="vf-bloom-menu"
        role="menu"
        aria-label="New terminal"
        tabIndex={-1}
        aria-activedescendant={view.open && view.activeDescendant ? domId(view.activeDescendant) : undefined}
        // A host's capture-phase key listeners yield what the bloom holds: its target is in here.
        data-bloom-holds-keys={holdsKeys ? 'true' : undefined}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      >
        {buds.map(({ bud, ghost }) => {
          const back = ghost || bud.back;
          const classes = ['vf-bloom-bud'];
          if (!back && isOut(bud)) classes.push('is-out');
          if (back) classes.push('is-back');
          if (bud.chosen) classes.push('is-chosen');
          if (bud.hot) classes.push('is-hot');
          if (bud.path) classes.push('is-path');
          if (bud.dim) classes.push('is-dim');
          if (bud.off) classes.push('is-off');
          if (bud.focus && view.open) classes.push('is-focus');
          // a collapsed ring goes home on its entrance stagger, as the prototype's
          // closeLevel2 leaves it; a closing bloom on the core's exit delays
          const delay = back && !ghost ? bud.exitDelay : bud.delay;
          const style = budStyle(bud, delay, bud.chosen ? (closed?.grow ?? null) : null);
          return (
            <div
              key={bud.id}
              id={domId(bud.id)}
              className={classes.join(' ')}
              role="menuitem"
              aria-label={bud.aria}
              aria-disabled={bud.off ? true : undefined}
              data-bloom-bud-kind={bud.kind}
              data-bloom-bud-id={bud.kind === 'device' ? bud.item.device.id : bud.item.profile?.id}
              data-bloom-bud-device={bud.item.device.id}
              data-bloom-ring={bud.level}
              style={style}
            >
              <BudFace bud={bud} />
            </div>
          );
        })}
        {buds.map(({ bud, ghost }) => {
          const step = stage.steps.get(bud.id);
          const seat = step?.seat ?? seatOf(bud);
          const leaving = ghost || !!closed;
          const classes = ['vf-bloom-label'];
          if (!leaving && isOut(bud)) classes.push('is-out');
          if (bud.hot) classes.push('is-hot');
          if (bud.dim) classes.push('is-dim');
          if (seat.short) classes.push('is-short');
          if (seat.gone) classes.push('is-gone');
          if (step) classes.push('is-stepping');
          return (
            <div
              key={`${bud.id}:label`}
              className={classes.join(' ')}
              data-align={seat.box.align}
              aria-hidden="true"
              style={
                {
                  left: seat.box.x,
                  top: seat.box.y,
                  width: seat.box.w,
                  // the words leave WITH their bud, not after their reveal delay
                  '--mv-swarm-bloom-delay': `${leaving ? 0 : Math.round(bud.labelDelay)}ms`,
                } as CSSProperties
              }
            >
              <span>{bud.name}</span>
              {bud.sub ? <small>{bud.sub}</small> : null}
            </div>
          );
        })}
      </div>
      <div className="vf-bloom-say-root" aria-live="polite">
        {stage.retiring.map((slate) => (
          <SlateView key={slate.key} say={slate.say} stepping="out" />
        ))}
        {view.say && sayKey ? (
          <SlateView
            key={sayKey}
            say={view.say}
            stepping={stage.retired.has(sayKey) ? 'out' : !posed && stage.entering === sayKey ? 'in' : null}
          />
        ) : null}
      </div>
    </div>
  );
}
