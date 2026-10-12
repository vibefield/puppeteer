import { describe, expect, it } from 'vitest';
import type { MonitorSpawnDevice } from '@vibefield/puppeteer-view-sdk';
import type { BloomTextMeasure } from './constants.js';
import { menuOf, type BloomDeviceItem, type BloomOpenMenu, type BloomProfileItem } from './menu.js';
import { BLOOM_SCENARIOS } from './scenarios.js';
import { measureWords, placeWords, wordsFor, type BloomWords } from './words.js';

// characters × font px × 0.6, as every bloom test measures
const measure: BloomTextMeasure = (text, font) => text.length * Number(/([\d.]+)px/.exec(font)?.[1] ?? 0) * 0.6;

const three = menuOf(BLOOM_SCENARIOS.three) as BloomOpenMenu;
const item = (id: string) => three.items.find((i) => i.device.id === id) as BloomDeviceItem;
const mini = item('mini');
const air = item('air');
const profileOn = (device: MonitorSpawnDevice, id: string): BloomProfileItem => ({
  kind: 'profile',
  device,
  profile: (device.profiles ?? []).find((p) => p.id === id) as NonNullable<BloomProfileItem['profile']>,
});
const personal = profileOn(mini.device, 'personal');
const text = (w: BloomWords) => w.parts.map((p) => p[0]).join('');

describe('wordsFor — the prototype’s specimen, every reading', () => {
  it('on the hub', () => {
    expect(wordsFor(three, { kind: 'hub' }, 'hold')).toEqual({
      parts: [
        ['New ', 'v'],
        ['terminal', 'n'],
      ],
      detail: 'ON STUDIO (HERE) · UNDER WORK · THE DEFAULT',
      tone: 'go',
    });
  });

  it('reaching a desktop (its native default reads DEFAULT, SB-D10, and is not said twice)', () => {
    const words = wordsFor(three, { kind: 'device', item: mini }, 'hold');
    expect(text(words)).toBe('Open on mini');
    expect(words.detail).toBe('UNDER DEFAULT');
  });

  it('reaching a desktop whose default is a managed set names it as its default', () => {
    const device: MonitorSpawnDevice = {
      ...mini.device,
      profiles: (mini.device.profiles ?? []).map((p) => ({ ...p, isDefault: p.id === 'personal' })),
    };
    const menu = menuOf({ devices: [BLOOM_SCENARIOS.two.devices[0] as MonitorSpawnDevice, device] }) as BloomOpenMenu;
    const words = wordsFor(menu, { kind: 'device', item: menu.items[1] as BloomDeviceItem }, 'hold');
    expect(words.detail).toBe('UNDER PERSONAL · ITS DEFAULT');
  });

  it('on a profile', () => {
    const words = wordsFor(three, { kind: 'profile', item: personal }, 'hold');
    expect(words.parts).toEqual([
      ['Open as ', 'v'],
      ['Personal', 'n'],
    ]);
    expect(words.detail).toBe('ON MINI · ALPHA · BETA SIGNED IN');
  });

  it('on a desktop asleep', () => {
    expect(wordsFor(three, { kind: 'device', item: air }, 'hold')).toEqual({
      parts: [
        ['Air', 'n'],
        [' is asleep', 'v'],
      ],
      detail: 'NOTHING OPENS · ASLEEP · 2 H',
      tone: 'off',
    });
  });

  it('on open ground, in each mode', () => {
    expect(wordsFor(three, { kind: 'none' }, 'hold')).toEqual({
      parts: [['Cancel', 'n']],
      detail: 'LET GO · NOTHING OPENS',
      tone: 'none',
    });
    expect(wordsFor(three, null, 'sticky').detail).toBe('CLICK · NOTHING OPENS');
    expect(wordsFor(three, { kind: 'none' }, 'keys').detail).toBe('PRESS ↵ · NOTHING OPENS');
  });

  it('after letting go', () => {
    expect(text(wordsFor(three, { kind: 'profile', item: personal }, 'hold', 'commit'))).toBe('Opening as Personal');
    expect(text(wordsFor(three, { kind: 'hub' }, 'hold', 'commit'))).toBe('Opening terminal');
    expect(text(wordsFor(three, { kind: 'device', item: mini }, 'hold', 'commit'))).toBe('Opening on mini');
  });
});

describe('wordsFor — SB-D10 and the product’s own cases', () => {
  it('a peer’s native profile opens ON the peer, UNDER DEFAULT', () => {
    const words = wordsFor(three, { kind: 'profile', item: profileOn(mini.device, 'native') }, 'hold');
    expect(text(words)).toBe('Open on mini');
    expect(words.detail).toBe('UNDER DEFAULT · ALPHA · BETA · GAMMA · DELTA SIGNED IN');
  });

  it('this desktop’s native profile keeps its own name', () => {
    const one = menuOf(BLOOM_SCENARIOS['one-three']) as BloomOpenMenu;
    const native = one.items[0] as BloomProfileItem;
    const words = wordsFor(one, { kind: 'profile', item: native }, 'hold');
    expect(text(words)).toBe('Open as This Mac');
    expect(words.detail).toBe('ALPHA · BETA · GAMMA · DELTA SIGNED IN');
    // one desktop: the words do not say where
    expect(wordsFor(one, { kind: 'hub' }, 'hold').detail).toBe('UNDER WORK · THE DEFAULT');
  });

  it('a desktop still reading its profiles names no default twice', () => {
    const reading: MonitorSpawnDevice = { id: 'mini', label: 'mini', state: 'reading' };
    const menu = menuOf({ devices: [BLOOM_SCENARIOS.two.devices[0] as MonitorSpawnDevice, reading] }) as BloomOpenMenu;
    const words = wordsFor(menu, { kind: 'device', item: menu.items[1] as BloomDeviceItem }, 'hold');
    expect(text(words)).toBe('Open on mini');
    expect(words.detail).toBe('UNDER ITS DEFAULT');
  });
});

describe('measureWords', () => {
  const words = wordsFor(three, { kind: 'profile', item: personal }, 'hold');

  it('keeps one line where it fits', () => {
    const m = measureWords(words, 40, 1000, measure);
    expect(m.twoLine).toBe(false);
    expect(m.size).toBe(40);
    // one 40 px line (× 0.98) and one detail line (10 + 14)
    expect(m.h).toBe(Math.ceil(40 * 0.98 + 24));
  });

  it('breaks verb and noun onto a line each where one line is wider than the field allows', () => {
    const one = measureWords(words, 40, undefined, measure);
    const two = measureWords(words, 40, one.w - 40, measure);
    expect(two.twoLine).toBe(true);
    expect(two.w).toBeLessThan(one.w);
    expect(two.h).toBeGreaterThan(one.h);
  });
});

describe('placeWords', () => {
  const field = { w: 1000, h: 500 };
  const words = wordsFor(three, { kind: 'hub' }, 'hold');
  const bloomAt = (x: number, y: number) => [{ x: x - 30, y: y - 30, width: 60, height: 60 }];

  it('takes the place farthest from the bloom, off everything it draws', () => {
    const place = placeWords({ words, field, chrome: [], bloom: bloomAt(300, 300), bodies: [], measure });
    expect(place.key).toBe('2:0');
    expect(place.align).toBe('right');
    expect(place.m.size).toBe(66); // 6.6 % of the longer side
  });

  it('holds the place it has while the bloom moves under it (+200)', () => {
    const first = placeWords({ words, field, chrome: [], bloom: bloomAt(300, 300), bodies: [], measure });
    // centred, the two top corners are mirror images: alone, the first wins the tie
    const fresh = placeWords({ words, field, chrome: [], bloom: bloomAt(500, 300), bodies: [], measure });
    expect(fresh.key).toBe('0:0');
    const held = placeWords({
      words,
      field,
      chrome: [],
      bloom: bloomAt(500, 300),
      bodies: [],
      current: { key: first.key, size: first.m.size },
      measure,
    });
    expect(held.key).toBe(first.key);
  });

  it('prefers ground with no bodies, a lit body counting twice', () => {
    const clear = placeWords({ words, field, chrome: [], bloom: bloomAt(300, 300), bodies: [], measure });
    // a 40 px body under the words' corner costs 0.03 × 1,600 = 48: less than the
    // corner's lead over the next place (~68), until it is lit and counts twice
    const body = { x: clear.x + clear.m.w - 40, y: clear.y, width: 40, height: 40 };
    const one = placeWords({ words, field, chrome: [], bloom: bloomAt(300, 300), bodies: [body], measure });
    expect(one.key).toBe(clear.key);
    const lit = placeWords({ words, field, chrome: [], bloom: bloomAt(300, 300), bodies: [body, body], measure });
    expect(lit.key).not.toBe(clear.key);
  });

  it('breaks onto two lines on a narrow field', () => {
    const narrow = { w: 300, h: 470 };
    const long = wordsFor(three, { kind: 'profile', item: personal }, 'hold');
    const place = placeWords({ words: long, field: narrow, chrome: [], bloom: bloomAt(150, 400), bodies: [], measure });
    expect(place.m.twoLine).toBe(true);
    // the box is its widest line (the field less 2 × 22 at most) + 4
    expect(place.m.w).toBeLessThanOrEqual(narrow.w - 44 + 4);
  });

  it('never grows past the size it already has', () => {
    const place = placeWords({
      words,
      field,
      chrome: [],
      bloom: bloomAt(300, 300),
      bodies: [],
      current: { key: '0:0', size: 40 },
      measure,
    });
    expect(place.m.size).toBe(40);
  });
});
