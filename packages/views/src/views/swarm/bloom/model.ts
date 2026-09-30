// The spawn bloom's machine, as data. The prototype's controller
// (`SB.createBloom`: openLevel1, retarget, openLevel2, closeLevel2, roomFor,
// reseat, paint, placeWords, setWords, ringClearing, commitTarget, close,
// onKey, aim, choose, litFor, bloomRects) ported as pure transitions: each
// takes the environment and a state and returns a new state. Its DOM, CSS
// classes, timers and events become fields a renderer reads (`bloomView`).
//
// The renderer owns time: it passes `now` in and runs the motion (entry
// delays, the hub's shrink, the words' hold after a commit) from the numbers
// the state carries. Nothing here reads a clock, a canvas or the DOM.

import type {
  MonitorAgent,
  MonitorSpawnDevice,
  MonitorSpawnMenu,
  MonitorSpawnProfile,
} from '../../../monitor/types.js';
import type { SwarmClearing } from '../gpu/swarm-renderer.js';
import { BLOOM, type BloomTextMeasure } from './constants.js';
import {
  arcFits,
  labelCost,
  labelSize,
  layoutArc,
  seatLabel,
  type BloomArcSpec,
  type BloomBox,
  type BloomDisc,
  type BloomPoint,
  type BloomRect,
  type BloomRoom,
  type BloomSeg,
  type BloomSize,
} from './geometry.js';
import {
  blooms,
  budSub,
  deviceWord,
  glyphName,
  initials,
  menuOf,
  profileWord,
  ready,
  type BloomDeviceItem,
  type BloomGlyphName,
  type BloomMenuItem,
  type BloomOpenMenu,
} from './menu.js';
import { resolveTarget, targetItem, targetOf, type BloomTarget } from './targeting.js';
import { placeWords, wordsFor, type BloomMode, type BloomWords, type BloomWordsPlace } from './words.js';

/** A body on the field, for the words' placement: they prefer ground with none. */
export interface BloomBody {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  /** Its current scale; its box uses max(1, scale). */
  readonly scale?: number | undefined;
  /** How far it is lit above the veil right now, 0..1 (the renderer's eased mix). Over 0.5 counts twice. */
  readonly lit?: number | undefined;
  /** The row it draws: it counts twice while the bloom's target lights it (`litOf`). */
  readonly agent?: MonitorAgent | undefined;
}

/** What the machine reads from the world on every transition. */
export interface BloomEnv {
  /** The field's size, CSS px. */
  readonly field: BloomSize;
  /** The chrome over the field (the usage column, the claims): buds, labels and words keep off it. */
  readonly chrome?: readonly BloomRect[] | undefined;
  readonly measure: BloomTextMeasure;
  /** The renderer's clock, ms. Only differences matter (the settle window). */
  readonly now: number;
  /** Scales every duration and delay (the view's motion parameter); 1 by default. */
  readonly motionScale?: number | undefined;
  /** Reduced motion: no stagger (the buds appear together). */
  readonly reduced?: boolean | undefined;
  /** The bodies on the field, for where the words go. */
  readonly bodies?: readonly BloomBody[] | undefined;
  /** An idle body's radius (the swarm's `radiusIdle`, 50 by default): the chosen bud grows to it. */
  readonly idleRadius?: number | undefined;
}

/** A bud's face: a desktop's initial, or a profile's glyph (filled when it is the default). */
export type BloomFace =
  | { readonly kind: 'initial'; readonly text: string }
  | { readonly kind: 'glyph'; readonly glyph: BloomGlyphName; readonly filled: boolean };

/** One bud, as the machine placed it. */
export interface BloomBud {
  /** Unique within the bloom, and across blooms opened at different `now`. */
  readonly id: string;
  readonly level: 1 | 2;
  /** Its place in its ring's menu order: the feed order, left to right as you read. */
  readonly index: number;
  readonly kind: 'device' | 'profile';
  readonly item: BloomMenuItem;
  readonly x: number;
  readonly y: number;
  /** Its spoke's direction from the hub (ring one) or the open desktop (ring two), degrees. */
  readonly a: number;
  /** Its diameter at rest; hot, × BLOOM.hot. */
  readonly d: number;
  /** Where it flies out from and back to: the hub, or the open desktop. */
  readonly hx: number;
  readonly hy: number;
  readonly face: BloomFace;
  /** An agent under this profile waits on the person: the profile tabs' orange dot. */
  readonly dot: boolean;
  /** A desktop that cannot take a terminal now: faint, aria-disabled; letting go on it opens nothing. */
  readonly off: boolean;
  /** Its entry delay, ms: centre first, `stagger` apart (0 under reduced motion). */
  readonly delay: number;
  /** Its label's entry delay: `reveal` behind the bud. */
  readonly labelDelay: number;
  /** The label's name, and a desktop's state line ('' for none). */
  readonly name: string;
  readonly sub: string;
  /** Its accessible name. */
  readonly aria: string;
  /** Its label's full size, and its name alone (null without a state line). */
  readonly sizes: readonly [BloomSize, BloomSize | null];
  /** Where its label stands now (whole px; 12 tall when short). */
  readonly box: BloomBox;
  /** The name alone: the state line gave way. */
  readonly short: boolean;
  /** The label gave way altogether (boxed in; the words name the desktop). */
  readonly gone: boolean;
  /** Where the first ring seated its label: restored when a second ring collapses. */
  readonly home: { readonly box: BloomBox; readonly short: boolean };
}

/** The desktop whose profiles are open. */
export interface BloomOpenDesktop {
  readonly budId: string;
  readonly item: BloomDeviceItem;
  readonly pos: BloomPoint;
  /** Its ring ignores the pointer until then (`settle`). */
  readonly readyAt: number;
}

/** The words where they stand. A new `slate` is a new reading: the old one steps out as it steps in. */
export interface BloomSay extends BloomWordsPlace {
  readonly slate: number;
  readonly words: BloomWords;
  /** The words as a key (their JSON). */
  readonly text: string;
}

/** How the bloom ended; the renderer plays the rest from these numbers. */
export interface BloomClosed {
  readonly reason: 'commit' | 'cancel';
  /** The bud let go on: it grows by `grow` and fades as the canvas body takes its place. Null: the hub, or nothing. */
  readonly chosen: string | null;
  /** An idle body's diameter over the chosen bud's. */
  readonly grow: number | null;
  /** How long the commit words ("Opening …") and their clearing stay, ms (0 for a cancel). */
  readonly sayHold: number;
  /** How long the hub takes to shrink back into the press point, ms. */
  readonly retract: number;
  /** Each retracting bud's delay, by id, ms. */
  readonly exitDelay: Readonly<Record<string, number>>;
}

/** The whole bloom. Transitions return a new state; nothing mutates one in place. */
export interface BloomState {
  /** The press point: the hub. */
  readonly P: BloomPoint;
  readonly mode: BloomMode;
  readonly menu: BloomOpenMenu;
  /** Ring one's direction (−90: up). */
  readonly theta: number;
  readonly l1: readonly BloomBud[];
  readonly l2: readonly BloomBud[];
  readonly l1step: number;
  readonly l2step: number;
  readonly open: BloomOpenDesktop | null;
  readonly target: BloomTarget | null;
  /** The keyboard's bud in the current ring; −1: none (↵ commits the hub). */
  readonly focus: number;
  readonly pointer: BloomPoint;
  readonly startedAt: number;
  readonly words: BloomWords | null;
  readonly say: BloomSay | null;
  /** Buds handed out (ids). */
  readonly seq: number;
  /** Slates handed out. */
  readonly slates: number;
  /** Set once the bloom has ended; every transition then leaves the state as it is. */
  readonly closed: BloomClosed | null;
}

/** What a commit asks the host to create: `createAt(at, { deviceId, profileSet })`. */
export interface BloomChoice {
  readonly deviceId: string | undefined;
  readonly profileSet: string | undefined;
  /** Where the terminal is born: the chosen bud's centre (SB-D2: where you let go), or the hub. */
  readonly at: BloomPoint;
  readonly device: MonitorSpawnDevice | null;
  readonly profile: MonitorSpawnProfile | null;
  readonly via: 'hub' | 'device' | 'profile' | 'instant';
  /** What the birth grows from: the chosen bud at its hot size (ink), or the hub (surface); null for an instant create. */
  readonly from: { readonly d: number; readonly fill: 'ink' | 'surface' } | null;
}

/** A menu with nothing to choose: create at once, today's hold. */
export interface BloomInstant {
  readonly instant: BloomChoice;
}

/** A commit's outcome. `choice` null: nothing opens — open ground, or `unready` (a faint desktop:
 * the host says "air is asleep — nothing opened"). */
export interface BloomCommit {
  readonly choice: BloomChoice | null;
  readonly unready?: MonitorSpawnDevice | undefined;
  readonly state: BloomState;
}

/** A key's outcome: `commit` when it let go, `cancel` when it closed the bloom; `handled` → preventDefault. */
export interface BloomKeyResult {
  readonly state: BloomState;
  readonly handled: boolean;
  readonly commit?: BloomCommit | undefined;
  readonly cancel?: true | undefined;
}

// ── drafts: a transition copies the buds it may touch, then works in place ──

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Bud = Mutable<BloomBud>;
interface Draft extends Omit<Mutable<BloomState>, 'l1' | 'l2'> {
  l1: Bud[];
  l2: Bud[];
}

function draft(s: BloomState): Draft {
  return { ...s, l1: s.l1.map((b) => ({ ...b })), l2: s.l2.map((b) => ({ ...b })) };
}

const ms = (env: BloomEnv, v: number): number => (env.motionScale ?? 1) * v;

function hubDisc(s: Draft | BloomState): BloomDisc {
  return { x: s.P.x, y: s.P.y, r: BLOOM.hubR + 2 };
}

function labelRect(b: BloomBud): BloomRect | null {
  if (b.gone) return null;
  return { x: b.box.x, y: b.box.y, width: b.box.w, height: b.box.h };
}

/** A bud's words, seated: where they stand, whether they are the name alone, whether they gave way. */
function applySeat(b: Bud, box: BloomBox, short: boolean, gone: boolean): void {
  b.box = { x: Math.round(box.x), y: Math.round(box.y), w: box.w, h: short ? 12 : box.h, align: box.align };
  b.short = !!short;
  b.gone = !!gone;
}

function openBud(s: Draft): Bud | undefined {
  const open = s.open;
  return open ? s.l1.find((b) => b.id === open.budId) : undefined;
}

interface BudSpec {
  x: number;
  y: number;
  a: number;
  hx: number;
  hy: number;
  label: BloomBox;
  short: boolean;
  name: string;
  sub: string;
  aria: string;
}

function budFor(
  env: BloomEnv,
  s: Draft,
  item: BloomMenuItem,
  level: 1 | 2,
  index: number,
  pos: BudSpec,
  face: BloomFace,
  delay: number,
): Bud {
  s.seq += 1;
  const home = { box: pos.label, short: pos.short };
  const b: Bud = {
    id: `bud-${Math.round(s.startedAt)}-${s.seq}`,
    level,
    index,
    kind: item.kind,
    item,
    x: pos.x,
    y: pos.y,
    a: pos.a,
    d: level === 1 ? BLOOM.bud1 : BLOOM.bud2,
    hx: pos.hx,
    hy: pos.hy,
    face,
    dot: item.kind === 'profile' && !!item.profile.blocked,
    off: !ready(item.device),
    delay,
    labelDelay: delay + ms(env, BLOOM.reveal),
    name: pos.name,
    sub: pos.sub,
    aria: pos.aria,
    sizes: [
      labelSize({ name: pos.name, sub: pos.sub }, env.measure),
      pos.sub ? labelSize({ name: pos.name }, env.measure) : null,
    ],
    box: pos.label,
    short: false,
    gone: false,
    home,
  };
  applySeat(b, pos.label, pos.short, false);
  b.home = { box: b.box, short: b.short };
  return b;
}

function glyphFace(profile: MonitorSpawnProfile): BloomFace {
  return { kind: 'glyph', glyph: glyphName(profile), filled: !!profile.isDefault };
}

/** Indices of `n` items, centre first (ties keep their order). */
function centreFirst(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i).sort((a, b) => Math.abs(a - (n - 1) / 2) - Math.abs(b - (n - 1) / 2));
}

/** The room a bud's words have: everything the bloom draws except that bud —
 * every other bud at its hot size, the hub, the spokes that are drawn or can
 * be, the chrome, and every other bud's words. */
function roomFor(env: BloomEnv, s: Draft, except: Bud): BloomRoom {
  const rects: BloomRect[] = (env.chrome ?? []).slice();
  const discs: BloomDisc[] = [hubDisc(s)];
  const segs: BloomSeg[] = [];
  for (const o of [...s.l1, ...s.l2]) {
    if (o === except) continue;
    discs.push({ x: o.x, y: o.y, r: (o.d * BLOOM.hot) / 2 });
    const L = labelRect(o);
    if (L) rects.push(L);
  }
  if (s.open) {
    const c = s.open.pos;
    segs.push({ a: s.P, b: c });
    for (const o of s.l2) segs.push({ a: c, b: { x: o.x, y: o.y } });
  } else {
    for (const o of s.l1) segs.push({ a: s.P, b: { x: o.x, y: o.y } });
  }
  return { field: env.field, rects, discs, segs };
}

/** Everything the bloom draws, as rectangles: the hub's dead zone, each bud at its hot size, each seated label. */
export function bloomRects(s: Pick<BloomState, 'P' | 'l1' | 'l2'>): BloomRect[] {
  const out: BloomRect[] = [
    { x: s.P.x - BLOOM.deadR, y: s.P.y - BLOOM.deadR, width: BLOOM.deadR * 2, height: BLOOM.deadR * 2 },
  ];
  for (const b of [...s.l1, ...s.l2]) {
    const d = b.d * BLOOM.hot;
    out.push({ x: b.x - d / 2, y: b.y - d / 2, width: d, height: d });
    const L = labelRect(b);
    if (L) out.push(L);
  }
  return out;
}

/** Which rows a target lights (SB-D8): a desktop lights its rows — for the
 * desktop you sit at, every row that is not remote; for a peer, the rows whose
 * `remote.deviceId` is it — and a profile (or the hub, under the default)
 * lights the rows under that profile set on that desktop. Open ground: none. */
function litFor(menu: BloomOpenMenu, t: BloomTarget | null): (agent: MonitorAgent) => boolean {
  if (!t || t.kind === 'none') return () => false;
  const device = t.kind === 'hub' ? menu.hub.device : t.item.device;
  const profile = t.kind === 'hub' ? menu.hub.profile : t.kind === 'profile' ? t.item.profile : null;
  const here = device.id === menu.self.id;
  return (agent) => {
    const on = here ? !agent.remote : agent.remote?.deviceId === device.id;
    if (!on) return false;
    if (!profile) return true;
    return agent.profileSet === profile.id;
  };
}

function bodyBoxes(env: BloomEnv, s: Draft): BloomRect[] {
  const lit = s.target ? litFor(s.menu, s.target) : null;
  const out: BloomRect[] = [];
  for (const b of env.bodies ?? []) {
    const r = b.r * Math.max(1, b.scale || 1) + 8;
    const box = { x: b.x - r, y: b.y - r, width: r * 2, height: r * 2 };
    out.push(box);
    if ((b.lit ?? 0) > 0.5 || (lit && b.agent && lit(b.agent))) out.push(box);
  }
  return out;
}

/** A change of words is a new slate over the old one — only when the words
 * themselves, their place or their size changed. */
function setWords(env: BloomEnv, s: Draft, words: BloomWords): void {
  s.words = words;
  const text = JSON.stringify(words);
  const place = placeWords({
    words,
    field: env.field,
    chrome: env.chrome ?? [],
    bloom: bloomRects(s),
    bodies: bodyBoxes(env, s),
    current: s.say ? { key: s.say.key, size: s.say.m.size } : null,
    measure: env.measure,
  });
  if (s.say && s.say.text === text && s.say.key === place.key && s.say.m.size === place.m.size) return;
  s.slates += 1;
  s.say = { ...place, slate: s.slates, words, text };
}

function openLevel1(env: BloomEnv, P: BloomPoint, mode: BloomMode, menu: BloomOpenMenu): Draft {
  const labels = menu.items.map((item) =>
    item.kind === 'device'
      ? { name: deviceWord(item.device), sub: budSub(item) }
      : { name: profileWord(item.profile, item.device), sub: '' },
  );
  const chrome = env.chrome ?? [];
  const hub: BloomDisc = { x: P.x, y: P.y, r: BLOOM.hubR + 2 };
  const layout = layoutArc({
    cx: P.x,
    cy: P.y,
    r: BLOOM.r1,
    d: BLOOM.bud1,
    step: BLOOM.step1,
    prefer: -90,
    labels,
    field: env.field,
    obstacles: chrome,
    discs: [hub],
    measure: env.measure,
    // a desktop that blooms needs somewhere for its profiles to go
    also: (pts) => {
      let c = 0;
      pts.forEach((pt, j) => {
        const item = menu.items[j];
        if (!item || item.kind !== 'device' || !blooms(item.device)) return;
        const discs: BloomDisc[] = [hub, ...pts.map((o) => ({ x: o.x, y: o.y, r: (BLOOM.bud1 * BLOOM.hot) / 2 }))];
        const room: BloomArcSpec = {
          cx: pt.x,
          cy: pt.y,
          r: BLOOM.r2,
          d: BLOOM.bud2,
          step: BLOOM.step2,
          prefer: pt.a,
          field: env.field,
          obstacles: chrome,
          discs,
          segs: [{ a: P, b: pt }],
        };
        const n = (item.device.profiles ?? []).length;
        if (!arcFits(room, n, 90)) c += arcFits(room, n, 180) ? 20 : 40;
      });
      return c;
    },
  });
  const faces = menu.kind === 'devices' ? initials(menu.items.map((i) => i.device)) : [];
  // layout items come back in reading order: the menu's order, left to right
  const order = layout.items;
  const s: Draft = {
    P,
    mode,
    menu,
    theta: layout.theta,
    l1: [],
    l2: [],
    l1step: layout.step,
    l2step: BLOOM.step2,
    open: null,
    target: null,
    focus: -1,
    pointer: { x: P.x, y: P.y },
    startedAt: env.now,
    words: null,
    say: null,
    seq: 0,
    slates: 0,
    closed: null,
  };
  const ranks = centreFirst(order.length);
  menu.items.forEach((item, i) => {
    const at = order[i];
    if (!at) return;
    const delay = env.reduced ? 0 : ms(env, ranks.indexOf(i) * BLOOM.stagger);
    const aria =
      item.kind === 'device'
        ? item.device.label +
          (item.device.self ? ', this device' : '') +
          (ready(item.device)
            ? ', ' + (item.device.profiles ?? []).length + ' profiles'
            : ', ' + (item.device.word || 'unavailable').toLowerCase())
        : item.profile.label + (item.profile.isDefault ? ', default' : '');
    const label = labels[i] as { name: string; sub: string };
    const face: BloomFace =
      item.kind === 'profile' ? glyphFace(item.profile) : { kind: 'initial', text: faces[i] ?? '?' };
    s.l1.push(
      budFor(
        env,
        s,
        item,
        1,
        i,
        { x: at.x, y: at.y, a: at.a, hx: P.x, hy: P.y, label: at.label, short: at.short, ...label, aria },
        face,
        delay,
      ),
    );
  });
  retarget(env, s, P, true);
  return s;
}

function openLevel2(env: BloomEnv, s: Draft, bud: Bud): void {
  const item = bud.item;
  if (item.kind !== 'device') return;
  const device = item.device;
  const profiles = device.profiles ?? [];
  if (!ready(device) || profiles.length < 2) return;
  closeLevel2(s);
  // the hub, the open desktop, the dimmed siblings and their words are solid
  // to the second ring, and so is the spoke that led here
  const obs: BloomRect[] = (env.chrome ?? []).slice();
  const discs: BloomDisc[] = [hubDisc(s), { x: bud.x, y: bud.y, r: (bud.d * BLOOM.hot) / 2 }];
  for (const o of s.l1) {
    if (o === bud) continue;
    discs.push({ x: o.x, y: o.y, r: (o.d * BLOOM.hot) / 2 });
    const L = labelRect(o);
    if (L) obs.push(L);
  }
  const labels = profiles.map((p) => ({ name: profileWord(p, device), sub: '' }));
  const layout = layoutArc({
    cx: bud.x,
    cy: bud.y,
    r: BLOOM.r2,
    d: BLOOM.bud2,
    step: BLOOM.step2,
    prefer: bud.a,
    labels,
    field: env.field,
    obstacles: obs,
    discs,
    segs: [{ a: s.P, b: { x: bud.x, y: bud.y } }],
    extra: { x: bud.x, y: bud.y, d: bud.d, natural: bud.home.box, short: bud.home.short, sizes: bud.sizes },
    measure: env.measure,
  });
  const order = layout.items;
  s.l2step = layout.step;
  s.open = { budId: bud.id, item, pos: { x: bud.x, y: bud.y }, readyAt: env.now + ms(env, BLOOM.settle) };
  const ranks = centreFirst(order.length);
  profiles.forEach((p, i) => {
    const at = order[i];
    if (!at) return;
    const delay = env.reduced ? 0 : ms(env, ranks.indexOf(i) * BLOOM.stagger);
    const name = (labels[i] as { name: string }).name;
    s.l2.push(
      budFor(
        env,
        s,
        { kind: 'profile', device, profile: p },
        2,
        i,
        {
          x: at.x,
          y: at.y,
          a: at.a,
          hx: bud.x,
          hy: bud.y,
          label: at.label,
          short: at.short,
          name,
          sub: '',
          aria: profileWord(p, device) + (p.isDefault ? ', default' : '') + ', on ' + device.label,
        },
        glyphFace(p),
        delay,
      ),
    );
  });
  // The open desktop's words keep their place if its profiles left it clear,
  // and otherwise take the nearest clear place around it — never a sibling,
  // the hub, the spoke or a profile's words. Boxed in, they give way: the
  // words in the field already name the desktop.
  const seat = seatLabel(bud.x, bud.y, bud.d, bud.home.box, bud.sizes, roomFor(env, s, bud), bud.home.short);
  applySeat(bud, seat.box, seat.short, seat.cost > 0);
  // a sibling's words the profiles landed on move aside the same way
  for (const o of s.l1) {
    if (o === bud || o.gone) continue;
    const room = roomFor(env, s, o);
    if (labelCost(o.box, room) === 0) continue;
    const moved = seatLabel(o.x, o.y, o.d, o.box, o.sizes, room, o.short);
    applySeat(o, moved.box, moved.short, moved.cost > 0);
  }
  if (s.words) setWords(env, s, s.words);
}

/** Every desktop's words go back to where the first ring put them. */
function closeLevel2(s: Draft): void {
  if (!s.open) return;
  s.l2 = [];
  for (const o of s.l1) {
    if (o.gone || o.box.x !== o.home.box.x || o.box.y !== o.home.box.y || o.short !== o.home.short) {
      applySeat(o, o.home.box, o.home.short, false);
    }
  }
  s.open = null;
}

function retarget(env: BloomEnv, s: Draft, p: BloomPoint, force: boolean): void {
  s.pointer = p;
  let r = resolveTarget(s, p, env.now);
  if (r.collapse) {
    closeLevel2(s);
    r = resolveTarget(s, p, env.now);
  }
  let t = r.t;
  // reaching a desktop opens it
  if (!s.open && t.kind === 'device' && t.d !== undefined && t.d >= BLOOM.r1 - BLOOM.reach && blooms(t.item.device)) {
    const item = t.item;
    const bud = s.l1.find((b) => b.item === item);
    if (bud) {
      openLevel2(env, s, bud);
      t = resolveTarget(s, p, env.now).t;
    }
  }
  const same = !!s.target && s.target.kind === t.kind && targetItem(s.target) === targetItem(t);
  s.target = t;
  if (!same || force) setWords(env, s, wordsFor(s.menu, t, s.mode));
}

function close(env: BloomEnv, s: Draft, reason: 'commit' | 'cancel', chosen: Bud | null, grow: number | null): void {
  const exitDelay: Record<string, number> = {};
  [...s.l1, ...s.l2].forEach((b, i) => {
    if (b === chosen) return;
    exitDelay[b.id] = env.reduced ? 0 : ms(env, Math.min(i, 4) * 12);
  });
  s.closed = {
    reason,
    chosen: chosen ? chosen.id : null,
    grow,
    sayHold: reason === 'commit' ? ms(env, BLOOM.sayHold) : 0,
    retract: ms(env, BLOOM.retract),
    exitDelay,
  };
}

function findBud(s: Draft, item: BloomMenuItem, level: 1 | 2): Bud | undefined {
  const list = level === 2 ? s.l2 : s.l1;
  return list.find(
    (b) => b.item === item || (!!item.profile && b.item.profile === item.profile && b.item.device === item.device),
  );
}

function commitTarget(env: BloomEnv, s: Draft): Omit<BloomCommit, 'state'> {
  const t = s.target;
  const menu = s.menu;
  let choice: { device: MonitorSpawnDevice; profile: MonitorSpawnProfile | null } | null = null;
  let bud: Bud | undefined;
  if (t && t.kind === 'hub') choice = menu.hub;
  else if (t && t.kind === 'device') {
    choice = { device: t.item.device, profile: t.item.profile };
    bud = findBud(s, t.item, 1) ?? openBud(s);
  } else if (t && t.kind === 'profile') {
    choice = { device: t.item.device, profile: t.item.profile };
    bud = findBud(s, t.item, s.open ? 2 : 1);
  }
  if (!t || t.kind === 'none' || !choice || !ready(choice.device)) {
    const item = targetItem(t);
    const unready = item && !ready(item.device) ? item.device : undefined;
    close(env, s, 'cancel', null, null);
    return unready ? { choice: null, unready } : { choice: null };
  }
  const at = bud ? { x: bud.x, y: bud.y } : { x: s.P.x, y: s.P.y };
  const from = bud ? { d: bud.d * BLOOM.hot, fill: 'ink' as const } : { d: BLOOM.hubR * 2, fill: 'surface' as const };
  const grow = bud ? ((env.idleRadius ?? 50) * 2) / bud.d : null;
  setWords(env, s, wordsFor(menu, t, s.mode, 'commit'));
  close(env, s, 'commit', bud ?? null, grow);
  return {
    choice: {
      deviceId: choice.device.id,
      profileSet: choice.profile?.id,
      at,
      device: choice.device,
      profile: choice.profile,
      via: t.kind,
      from,
    },
  };
}

function aim(env: BloomEnv, s: Draft, bud: Bud | undefined): void {
  if (!bud) return;
  s.target = targetOf(bud.item);
  setWords(env, s, wordsFor(s.menu, s.target, s.mode));
}

function choose(env: BloomEnv, s: Draft, bud: Bud | undefined): Omit<BloomCommit, 'state'> | undefined {
  if (!bud) return undefined;
  if (bud.level === 1 && bud.item.kind === 'device' && blooms(bud.item.device)) {
    openLevel2(env, s, bud);
    const def = s.l2.findIndex((c) => !!c.item.profile?.isDefault);
    s.focus = def >= 0 ? def : 0;
    aim(env, s, s.l2[s.focus]);
    return undefined;
  }
  aim(env, s, bud);
  return commitTarget(env, s);
}

// ── the transitions ────────────────────────────────────────────────────────

/** Where the keyboard door opens a bloom: the field's middle, a little low. */
export function keysOrigin(field: BloomSize): BloomPoint {
  return { x: field.w * 0.5, y: field.h * 0.62 };
}

/** A hold completed at `P` (or a secondary click held it open: `sticky`; or the
 * keyboard door: `keys`, which focuses the first bud). A menu with nothing to
 * choose returns `{ instant }` — the host creates at once, today's hold. */
export function openBloom(
  env: BloomEnv,
  P: BloomPoint,
  mode: BloomMode,
  spawnMenu: MonitorSpawnMenu,
): BloomState | BloomInstant {
  const menu = menuOf(spawnMenu);
  if (menu.kind === 'instant') {
    return {
      instant: {
        deviceId: menu.hub.device?.id,
        profileSet: menu.hub.profile?.id,
        at: { x: P.x, y: P.y },
        device: menu.hub.device,
        profile: menu.hub.profile,
        via: 'instant',
        from: null,
      },
    };
  }
  const s = openLevel1(env, P, mode, menu);
  if (mode === 'keys') {
    s.focus = 0;
    aim(env, s, s.l1[0]);
  }
  return s;
}

export function isInstant(opened: BloomState | BloomInstant): opened is BloomInstant {
  return 'instant' in opened;
}

/** The pointer moved: retarget. Reaching a desktop that blooms opens its
 * profiles; backing out toward the hub, or reaching a sibling, collapses them.
 * The words change only when the target does (a new `say.slate`), or when a
 * second ring opens into them. */
export function pointBloom(env: BloomEnv, state: BloomState, p: BloomPoint): BloomState {
  if (state.closed) return state;
  const s = draft(state);
  retarget(env, s, { x: p.x, y: p.y }, false);
  return s;
}

/** Letting go (a hold's release, a sticky bloom's click): commit what is
 * targeted. The hub → this desktop's default; a desktop → its default; a
 * profile → exactly it; a faint desktop → nothing (`unready` names it); open
 * ground → nothing. The state comes back closed. */
export function commitBloom(env: BloomEnv, state: BloomState): BloomCommit {
  if (state.closed) return { choice: null, state };
  const s = draft(state);
  const out = commitTarget(env, s);
  return { ...out, state: s };
}

/** Put the bloom away: Esc in a hold, a secondary click while held open, a cancelled pointer. */
export function cancelBloom(env: BloomEnv, state: BloomState): BloomState {
  if (state.closed) return state;
  const s = draft(state);
  close(env, s, 'cancel', null, null);
  return s;
}

/** A key while the bloom is open (KeyboardEvent.key). ←/→/↑/↓ cycle within the
 * current ring; ↵ or space on a desktop with ≥ 2 profiles opens it and focuses
 * its default profile, on anything else commits it, and with no focus commits
 * the hub; 1–9 pick; 0 is the hub; Esc backs out of an open desktop (not in a
 * hold), else cancels. A hold takes only Esc. */
export function keyBloom(env: BloomEnv, state: BloomState, key: string): BloomKeyResult {
  if (state.closed) return { state, handled: false };
  const s = draft(state);
  const list = s.open ? s.l2 : s.l1;
  if (key === 'Escape') {
    if (s.open && s.mode !== 'hold') {
      const dev = openBud(s);
      closeLevel2(s);
      s.focus = dev ? s.l1.indexOf(dev) : -1;
      aim(env, s, s.l1[s.focus]);
      return { state: s, handled: true };
    }
    close(env, s, 'cancel', null, null);
    return { state: s, handled: true, cancel: true };
  }
  if (s.mode === 'hold') return { state, handled: false };
  if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowUp') {
    if (!list.length) return { state: s, handled: true };
    const dir = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1;
    s.focus = s.focus < 0 ? (dir > 0 ? 0 : list.length - 1) : (s.focus + dir + list.length) % list.length;
    aim(env, s, list[s.focus]);
    return { state: s, handled: true };
  }
  if (/^[0-9]$/.test(key)) {
    const n = Number(key);
    if (n === 0) {
      s.target = { kind: 'hub' };
      return { state: s, handled: true, commit: { ...commitTarget(env, s), state: s } };
    }
    if (n - 1 < list.length) {
      s.focus = n - 1;
      const out = choose(env, s, list[s.focus]);
      return out ? { state: s, handled: true, commit: { ...out, state: s } } : { state: s, handled: true };
    }
    return { state: s, handled: true };
  }
  if (key === 'Enter' || key === ' ') {
    if (s.focus < 0) {
      s.target = { kind: 'hub' };
      return { state: s, handled: true, commit: { ...commitTarget(env, s), state: s } };
    }
    const out = choose(env, s, list[s.focus]);
    return out ? { state: s, handled: true, commit: { ...out, state: s } } : { state: s, handled: true };
  }
  return { state, handled: false };
}

// ── what a renderer draws ────────────────────────────────────────────────────

/** A bud as drawn now. */
export interface BloomBudView extends BloomBud {
  /** Targeted: × BLOOM.hot, on --vf-ease-lift; its label too; aria-checked. */
  readonly hot: boolean;
  /** 0..1: how far the nearest bud leans in before it is targeted (scale 1 + lean × BLOOM.near). */
  readonly lean: number;
  /** The open desktop: lifted and ringed. */
  readonly path: boolean;
  /** A first-ring sibling while a desktop is open: × BLOOM.dim at BLOOM.dimAlpha, its label too. */
  readonly dim: boolean;
  /** The keyboard's bud (aria-activedescendant). */
  readonly focus: boolean;
  /** Let go on: grows by `closed.grow` and fades while the body takes its place. */
  readonly chosen: boolean;
  /** The bloom closed without it: back along its spoke to (hx, hy) after `exitDelay` (M4); its label leaves now. */
  readonly back: boolean;
  readonly exitDelay: number;
}

export interface BloomView {
  /** Still open (false once committed or cancelled: play the close). */
  readonly open: boolean;
  readonly level: 1 | 2;
  readonly mode: BloomMode;
  /** The hub (the hold ring, frozen at full size) at the press point. */
  readonly hub: BloomPoint;
  /** Ring one, then ring two. A bud that leaves the list (a collapse) retracts to its (hx, hy). */
  readonly buds: readonly BloomBudView[];
  /** The tether: from the hub's rim (through the open desktop) to the pointer; null when not drawn (keys, or inside the hub). */
  readonly tether: readonly BloomPoint[] | null;
  readonly words: BloomWords | null;
  /** The words' place and slate: a new slate steps in over the old. */
  readonly say: BloomSay | null;
  /** Solid ground under the bloom: ring one's circle, ring two's, the words' rect (≤ MAX_CLEARINGS). Once
   * committed, only the words' rect, for `closed.sayHold`. */
  readonly clearings: readonly SwarmClearing[];
  /** The field's quiet: BLOOM.veil while open, 0 once closed. */
  readonly veil: number;
  /** The focused bud's id, for aria-activedescendant. */
  readonly activeDescendant: string | null;
  readonly closed: BloomClosed | null;
}

/** A ring's clearing: solid out past its farthest bud (hot) and label corner, + clearPad, then the feather. */
function ringClearing(
  cx: number,
  cy: number,
  buds: readonly BloomBud[],
  extra: readonly (BloomRect | null)[],
): SwarmClearing {
  let r = BLOOM.hubR + 6;
  const reach = (px: number, py: number) => {
    r = Math.max(r, Math.hypot(px - cx, py - cy));
  };
  const boxes = extra.slice();
  for (const b of buds) {
    r = Math.max(r, Math.hypot(b.x - cx, b.y - cy) + (b.d * BLOOM.hot) / 2);
    const L = labelRect(b);
    if (L) boxes.push(L);
  }
  for (const L of boxes) {
    if (!L) continue;
    reach(L.x, L.y);
    reach(L.x + L.width, L.y);
    reach(L.x, L.y + L.height);
    reach(L.x + L.width, L.y + L.height);
  }
  return { kind: 'circle', x: cx, y: cy, radius: r + BLOOM.clearPad, feather: BLOOM.feather };
}

function sayClearing(say: BloomSay): SwarmClearing {
  return { kind: 'rect', x: say.x - 18, y: say.y - 14, width: say.m.w + 36, height: say.m.h + 28, feather: 64 };
}

function isHot(t: BloomTarget | null, b: BloomBud): boolean {
  if (!t) return false;
  if (t.kind === 'device') return b.item === t.item;
  if (t.kind === 'profile') return b.level === 2 ? b.item.profile === t.item.profile : b.item === t.item;
  return false;
}

/** Everything a renderer draws, derived from a state. */
export function bloomView(state: BloomState): BloomView {
  const s = state;
  const t = s.target;
  const list = s.open ? s.l2 : s.l1;
  const focused = s.focus >= 0 ? list[s.focus] : undefined;
  const openId = s.open?.budId;
  const closed = s.closed;
  const buds = [...s.l1, ...s.l2].map((b): BloomBudView => {
    const hot = isHot(t, b);
    const dist = Math.hypot(s.pointer.x - b.x, s.pointer.y - b.y);
    const chosen = !!closed && closed.chosen === b.id;
    return {
      ...b,
      hot,
      lean: hot ? 0 : Math.max(0, 1 - dist / (BLOOM.r1 * 0.9)),
      path: b.id === openId,
      dim: !!openId && b.level === 1 && b.id !== openId,
      focus: !!focused && b.id === focused.id,
      chosen,
      back: !!closed && !chosen,
      exitDelay: closed?.exitDelay[b.id] ?? 0,
    };
  });
  let tether: BloomPoint[] | null = null;
  if (!closed) {
    const pts: BloomPoint[] = [s.P];
    if (s.open) pts.push(s.open.pos);
    pts.push(s.pointer);
    const start = s.P;
    const next = pts[1] as BloomPoint;
    const len = Math.hypot(next.x - start.x, next.y - start.y);
    if (len > BLOOM.hubR && s.mode !== 'keys') {
      const rim = {
        x: start.x + ((next.x - start.x) / len) * BLOOM.hubR,
        y: start.y + ((next.y - start.y) / len) * BLOOM.hubR,
      };
      tether = [rim, ...pts.slice(1)];
    }
  }
  const clearings: SwarmClearing[] = [];
  if (!closed) {
    clearings.push(ringClearing(s.P.x, s.P.y, s.l1, []));
    const openBudNow = s.open ? s.l1.find((b) => b.id === openId) : undefined;
    if (s.open)
      clearings.push(ringClearing(s.open.pos.x, s.open.pos.y, s.l2, [openBudNow ? labelRect(openBudNow) : null]));
    if (s.say) clearings.push(sayClearing(s.say));
  } else if (closed.reason === 'commit' && s.say) {
    clearings.push(sayClearing(s.say));
  }
  return {
    open: !closed,
    level: s.open ? 2 : 1,
    mode: s.mode,
    hub: { x: s.P.x, y: s.P.y },
    buds,
    tether,
    words: s.words,
    say: s.say,
    clearings,
    veil: closed ? 0 : BLOOM.veil,
    activeDescendant: focused ? focused.id : null,
    closed,
  };
}

/** Which rows light while the bloom points (SB-D8): the target's desktop, or
 * its profile set on that desktop; nothing for open ground or once closed. */
export function litOf(state: BloomState): (agent: MonitorAgent) => boolean {
  if (state.closed) return () => false;
  return litFor(state.menu, state.target);
}
