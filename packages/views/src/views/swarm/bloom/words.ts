// THE WORDS: what letting go does, as a verb and a noun, huge, in the field's
// empty space (James, 2026-09-29: "huge bold minimal simple text … like
// kinect text design … concise verb and noun"). The noun is the thing you
// point at, at full ink; the verb steps back. One small line under it says
// where the terminal lands and under whom. The prototype's `wordsFor`,
// `measureWords` and the controller's `placeWords`, pure.

import type { MonitorSpawnProfile } from '@vibefield/puppeteer-view-sdk';
import { BLOOM, BLOOM_FONT, type BloomTextMeasure } from './constants.js';
import type { BloomAlign, BloomRect, BloomSize } from './geometry.js';
import { deviceWord, hereWord, profileWord, ready, type BloomOpenMenu } from './menu.js';
import type { BloomTarget } from './targeting.js';

/** How the bloom was opened: a hold (letting go commits), held open by a
 * secondary click (a click commits), or from the keyboard (↵ commits). */
export type BloomMode = 'hold' | 'sticky' | 'keys';

/** A run of the words: `v` the verb (stepped back), `n` the noun (full ink). */
export type BloomWordPart = readonly [text: string, role: 'v' | 'n'];

/** `go`: letting go opens something · `off`: a desktop that cannot take one · `none`: open ground. */
export type BloomTone = 'go' | 'off' | 'none';

export interface BloomWords {
  readonly parts: readonly BloomWordPart[];
  readonly detail: string;
  readonly tone: BloomTone;
}

function cap(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function signedWords(profile: MonitorSpawnProfile | null): string {
  const list = profile?.signedIn ?? [];
  if (!list.length) return '';
  return list.map((x) => x.toUpperCase()).join(' · ') + ' SIGNED IN';
}

/** The words for a target: *New terminal* (hub) · *Open on mini* (a desktop,
 * or a peer's native profile) · *Open as Personal* (a profile) · *Air is
 * asleep* (a faint desktop) · *Cancel* (open ground); `phase: 'commit'` says
 * *Opening …*. SB-D10: a peer's native set reads DEFAULT
 * (`UNDER DEFAULT · ALPHA · BETA SIGNED IN`), and reaching a peer whose
 * default it is reads `UNDER DEFAULT` alone, not `· ITS DEFAULT` after it. One product case the
 * prototype never met: a desktop still reading its profiles has no default
 * to name, so its detail is `UNDER ITS DEFAULT` alone, not doubled. */
export function wordsFor(
  menu: BloomOpenMenu,
  t: BloomTarget | null | undefined,
  mode: BloomMode,
  phase?: 'commit',
): BloomWords {
  const multi = menu.kind === 'devices';
  const going = phase === 'commit';
  const letGo = mode === 'keys' ? 'PRESS ↵' : mode === 'sticky' ? 'CLICK' : 'LET GO';
  if (!t || t.kind === 'none') return { parts: [['Cancel', 'n']], detail: letGo + ' · NOTHING OPENS', tone: 'none' };
  const device = t.kind === 'hub' ? menu.hub.device : t.item.device;
  const profile = t.kind === 'hub' ? menu.hub.profile : t.item.profile;
  if (!ready(device)) {
    return {
      parts: [
        [cap(device.label), 'n'],
        [' ' + (device.phrase || 'is away'), 'v'],
      ],
      detail: 'NOTHING OPENS · ' + (device.word || 'UNAVAILABLE'),
      tone: 'off',
    };
  }
  const where = multi ? 'ON ' + deviceWord(device) + (device.self ? ' (' + hereWord(device) + ')' : '') : '';
  const word = profileWord(profile, device);
  const under = 'UNDER ' + word;
  if (t.kind === 'hub') {
    return {
      parts: [
        [going ? 'Opening ' : 'New ', 'v'],
        ['terminal', 'n'],
      ],
      detail: [where, under + (profile?.isDefault ? ' · THE DEFAULT' : '')].filter(Boolean).join(' · '),
      tone: 'go',
    };
  }
  if (t.kind === 'device' || (profile && profile.kind === 'native' && !device.self)) {
    return {
      parts: [
        [going ? 'Opening on ' : 'Open on ', 'v'],
        [device.label, 'n'],
      ],
      // a default already called DEFAULT (a peer's native set, SB-D10) is not said twice
      detail:
        t.kind === 'device'
          ? profile && word !== 'DEFAULT'
            ? under + ' · ITS DEFAULT'
            : under
          : under + ' · ' + (signedWords(profile) || 'THE AGENTS’ OWN SIGN-INS'),
      tone: 'go',
    };
  }
  return {
    parts: [
      [going ? 'Opening as ' : 'Open as ', 'v'],
      [t.item.profile.label, 'n'],
    ],
    detail: [where, signedWords(profile)].filter(Boolean).join(' · '),
    tone: 'go',
  };
}

/** The words' box at a size. */
export interface BloomWordsMeasure {
  readonly w: number;
  readonly h: number;
  readonly size: number;
  /** The verb and the noun take a line each. */
  readonly twoLine: boolean;
}

/** The words' box at `size` px (`BLOOM_FONT.say`, −0.04 em; the detail in
 * `BLOOM_FONT.detail`, +0.12 em). Where one line is wider than `maxW`, the verb
 * and the noun take a line each (big type breaks, it does not shrink to a
 * whisper); the detail wraps under them. */
export function measureWords(
  words: BloomWords,
  size: number,
  maxW: number | undefined,
  measure: BloomTextMeasure,
): BloomWordsMeasure {
  const font = BLOOM_FONT.say(size);
  const widthOf = (text: string) => (measure(text, font) - 0.04 * size * Math.max(0, text.length - 1)) * 1.04;
  let w1 = widthOf(words.parts.map((part) => part[0]).join(''));
  let lines = 1;
  if (maxW && w1 > maxW && words.parts.length > 1) {
    const first = (words.parts[0] as BloomWordPart)[0].trim();
    const rest = words.parts
      .slice(1)
      .map((part) => part[0])
      .join('')
      .trim();
    w1 = Math.max(widthOf(first), widthOf(rest));
    lines = 2;
  }
  const w2 = words.detail ? measure(words.detail, BLOOM_FONT.detail) + 0.12 * 11 * words.detail.length : 0;
  const boxW = Math.max(w1, maxW ? Math.min(w2, maxW) : w2);
  const detailLines = words.detail ? Math.max(1, Math.ceil(w2 / Math.max(1, boxW))) : 0;
  return {
    w: Math.ceil(boxW + 4),
    h: Math.ceil(size * 0.98 * lines + (detailLines ? 10 + 14 * detailLines : 0)),
    size,
    twoLine: lines === 2,
  };
}

/** The area `box` shares with `rects`, each grown by `pad`. */
export function overlapArea(box: BloomRect, rects: readonly BloomRect[], pad: number): number {
  let sum = 0;
  for (const r of rects) {
    const ix = Math.min(box.x + box.width, r.x + r.width + pad) - Math.max(box.x, r.x - pad);
    const iy = Math.min(box.y + box.height, r.y + r.height + pad) - Math.max(box.y, r.y - pad);
    if (ix > 0 && iy > 0) sum += ix * iy;
  }
  return sum;
}

export interface BloomWordsPlaceInput {
  readonly words: BloomWords;
  readonly field: BloomSize;
  readonly chrome: readonly BloomRect[];
  /** Everything the bloom draws, as rectangles: the hub, each bud at its hot size, each seated label. */
  readonly bloom: readonly BloomRect[];
  /** Every body on the field as a box (r × max(1, scale) + 8 round its centre); a lit body's box is listed twice. */
  readonly bodies: readonly BloomRect[];
  /** Where the words stand now: they hold that place (+200) and never grow past its size. */
  readonly current?: { readonly key: string; readonly size: number } | null | undefined;
  readonly measure: BloomTextMeasure;
}

/** Where the words stand: their box's corner, their measure, the grid place
 * they took (`key`, for stickiness) and how their lines align in the field. */
export interface BloomWordsPlace {
  readonly x: number;
  readonly y: number;
  readonly m: BloomWordsMeasure;
  readonly key: string;
  readonly align: BloomAlign;
}

/** The widest empty space: a grid of places at the field's edges and middle
 * (and just past its chrome), each kept off the chrome and `sayGap` from
 * everything the bloom draws; of those, the one farthest from the bloom, +30
 * in the top third, +200 where the words already are (so they never hop as you
 * move between buds), minus 0.03 × the body area it would cover. If nothing
 * fits, the words get smaller (× 0.9 down to `sayMin`); if still nothing, the
 * least covered place. */
export function placeWords(input: BloomWordsPlaceInput): BloomWordsPlace {
  const { words, field: fs, chrome, bloom: rects, bodies: bodyBoxes, current, measure } = input;
  let ux0 = Infinity;
  let uy0 = Infinity;
  let ux1 = -Infinity;
  let uy1 = -Infinity;
  for (const r of rects) {
    ux0 = Math.min(ux0, r.x);
    uy0 = Math.min(uy0, r.y);
    ux1 = Math.max(ux1, r.x + r.width);
    uy1 = Math.max(uy1, r.y + r.height);
  }
  const cu = { x: (ux0 + ux1) / 2, y: (uy0 + uy1) / 2 };
  const inset = BLOOM.inset + 8;
  const maxSize = Math.round(Math.max(BLOOM.sayMin, Math.min(BLOOM.sayMax, Math.max(fs.w, fs.h) * 0.066)));
  const maxW = fs.w - (BLOOM.inset + 8) * 2;
  const start = current ? Math.min(maxSize, current.size) : maxSize;
  const settle = (box: BloomRect, key: string, mm: BloomWordsMeasure): BloomWordsPlace => {
    const cx = box.x + mm.w / 2;
    return { x: box.x, y: box.y, m: mm, key, align: cx < fs.w * 0.36 ? 'left' : cx > fs.w * 0.64 ? 'right' : 'center' };
  };
  let fallback: { box: BloomRect; key: string; cost: number; m: BloomWordsMeasure } | null = null;
  for (let size = start; size >= BLOOM.sayMin; size = Math.floor(size * 0.9)) {
    const m = measureWords(words, size, maxW, measure);
    const xs = [inset, (fs.w - m.w) / 2, fs.w - inset - m.w];
    const ys = [inset, (fs.h - m.h) / 2, fs.h - inset - m.h];
    for (const r of chrome) {
      xs.push(r.x + r.width + 20);
      ys.push(r.y + r.height + 16);
    }
    let best: { box: BloomRect; key: string; score: number } | null = null;
    xs.forEach((x, i) => {
      ys.forEach((y, j) => {
        const box = { x: Math.round(x), y: Math.round(y), width: m.w, height: m.h };
        const key = i + ':' + j;
        const out =
          Math.max(0, inset - box.x) +
          Math.max(0, box.x + m.w - (fs.w - inset)) +
          Math.max(0, inset - box.y) +
          Math.max(0, box.y + m.h - (fs.h - inset));
        const cost = out * 1000 + overlapArea(box, rects, BLOOM.sayGap) + overlapArea(box, chrome, 12);
        const cx = box.x + m.w / 2;
        const cy = box.y + m.h / 2;
        const crowd = overlapArea(box, bodyBoxes, 0) * 0.03;
        const score =
          Math.hypot(cx - cu.x, cy - cu.y) +
          (cy < fs.h * 0.34 ? 30 : 0) +
          (current && current.key === key && current.size === size ? 200 : 0) -
          crowd;
        if (cost === 0) {
          if (!best || score > best.score) best = { box, key, score };
        } else if (!fallback || cost < fallback.cost) {
          fallback = { box, key, cost, m };
        }
      });
    });
    const found = best as { box: BloomRect; key: string; score: number } | null;
    if (found) return settle(found.box, found.key, m);
  }
  const last = fallback as { box: BloomRect; key: string; cost: number; m: BloomWordsMeasure } | null;
  if (last) return settle(last.box, last.key, last.m);
  // only when `current.size` was already below sayMin: the smallest words, in the corner
  const m = measureWords(words, BLOOM.sayMin, maxW, measure);
  return settle({ x: inset, y: inset, width: m.w, height: m.h }, '0:0', m);
}
