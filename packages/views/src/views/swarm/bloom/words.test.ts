import { describe, expect, it } from 'vitest';
import type { MonitorSpawnDevice, MonitorSpawnFuel, MonitorSpawnProfile } from '@vibefield/puppeteer-view-sdk';
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

describe("the words name a profile's fuel", () => {
  const FUEL: MonitorSpawnFuel = { usedPercent: 42, word: 'Plan: 42% of 5 hours' };
  const wearing = (
    at: BloomProfileItem,
    fuel: MonitorSpawnFuel,
    more?: Partial<MonitorSpawnProfile>,
  ): BloomProfileItem => ({
    ...at,
    profile: { ...at.profile, ...more, fuel },
  });

  it('reaching a profile names its fuel after who is signed in', () => {
    const words = wordsFor(three, { kind: 'profile', item: wearing(personal, FUEL) }, 'hold');
    expect(words.detail).toBe('ON MINI · ALPHA · BETA SIGNED IN · PLAN: 42% OF 5 HOURS');
    expect(words.tone).toBe('go');
  });

  it("a peer's native profile names it too", () => {
    const item = wearing(profileOn(mini.device, 'native'), FUEL);
    const words = wordsFor(three, { kind: 'profile', item }, 'hold');
    expect(text(words)).toBe('Open on mini');
    expect(words.detail).toBe('UNDER DEFAULT · ALPHA · BETA · GAMMA · DELTA SIGNED IN · PLAN: 42% OF 5 HOURS');
  });

  it('a real fuel word under a wider headline does not cost the words their size', () => {
    const signedIn = ['Claude Code', 'Codex'];
    const bare: BloomProfileItem = { ...personal, profile: { ...personal.profile, signedIn } };
    const fuelled = wearing(bare, { usedPercent: 64, word: 'Claude Max: 64% of 5 hours' });
    const field = { w: 1000, h: 500 };
    const bloom = [{ x: 270, y: 270, width: 60, height: 60 }];
    const placed = (words: BloomWords) => placeWords({ words, field, chrome: [], bloom, bodies: [], measure });
    const words = wordsFor(three, { kind: 'profile', item: fuelled }, 'hold');
    expect(words.detail.endsWith(' · CLAUDE MAX: 64% OF 5 HOURS')).toBe(true);
    const place = placed(words);
    const before = placed(wordsFor(three, { kind: 'profile', item: bare }, 'hold'));
    expect(place.m.size).toBe(before.m.size);
    expect(place.m.w).toBe(before.m.w);
    expect(place.key).toBe(before.key);
  });

  describe('where the detail outgrows the headline', () => {
    const field = { w: 1000, h: 500 };
    const bare = wordsFor(three, { kind: 'profile', item: profileOn(mini.device, 'native') }, 'hold');
    const long = wordsFor(three, { kind: 'profile', item: wearing(profileOn(mini.device, 'native'), FUEL) }, 'hold');

    it('the box widens to the detail, and its size stands where the room is there', () => {
      const bloom = [{ x: 270, y: 270, width: 60, height: 60 }];
      const placed = (words: BloomWords) => placeWords({ words, field, chrome: [], bloom, bodies: [], measure });
      expect(placed(bare).m).toMatchObject({ w: 469, size: 66 });
      expect(placed(long).m).toMatchObject({ w: 614, size: 66 });
    });

    it('a size the longer line cost is kept for the rest of the gesture', () => {
      // a rule through the field leaves the 469-wide box a place at 66, and the 614-wide one only the strip above its
      // foot, which the 82 tall box of size 59 clears and the 89 tall box of size 66 does not
      const bloom = [{ x: 540, y: 148, width: 20, height: 352 }];
      const placed = (words: BloomWords, current?: { key: string; size: number }) =>
        placeWords({ words, field, chrome: [], bloom, bodies: [], current, measure });
      expect(placed(bare).m.size).toBe(66);
      const reached = placed(long);
      expect(reached.m.size).toBe(59);
      expect(placed(bare, { key: reached.key, size: reached.m.size }).m.size).toBe(59);
    });
  });

  it('the hub and a desktop say nothing of fuel', () => {
    const fuelledAll = (device: MonitorSpawnDevice): MonitorSpawnDevice => ({
      ...device,
      profiles: (device.profiles ?? []).map((p) => ({ ...p, fuel: FUEL })),
    });
    const devices = [fuelledAll(BLOOM_SCENARIOS.two.devices[0] as MonitorSpawnDevice), fuelledAll(mini.device)];
    const menu = menuOf({ devices }) as BloomOpenMenu;
    // the hub's own profile is fuelled here: its words would carry the clause if the hub ever said one
    expect(menu.hub.profile?.fuel).toBe(FUEL);
    expect(wordsFor(menu, { kind: 'hub' }, 'hold').detail).toBe('ON STUDIO (HERE) · UNDER WORK · THE DEFAULT');
    const words = wordsFor(menu, { kind: 'device', item: menu.items[1] as BloomDeviceItem }, 'hold');
    expect(words.detail).toBe('UNDER DEFAULT');
  });

  it('a hot or an old reading leaves the line one tone: the ring carries the orange', () => {
    const peer = profileOn(mini.device, 'native');
    for (const flags of [{ hot: true }, { stale: true }, { hot: true, stale: true }]) {
      const fuel = { ...FUEL, ...flags };
      expect(wordsFor(three, { kind: 'profile', item: wearing(personal, fuel) }, 'hold').tone).toBe('go');
      expect(wordsFor(three, { kind: 'profile', item: wearing(peer, fuel) }, 'hold').tone).toBe('go');
    }
  });

  it("a kept reading's age, worded by the host, reaches the line whole", () => {
    const fuel = { usedPercent: 64, stale: true, word: 'Claude Max: 64% of 5 hours, as of 5m ago' };
    const words = wordsFor(three, { kind: 'profile', item: wearing(personal, fuel) }, 'hold');
    expect(words.detail).toBe('ON MINI · ALPHA · BETA SIGNED IN · CLAUDE MAX: 64% OF 5 HOURS, AS OF 5M AGO');
  });

  it('a word that is not a string, or no fuel at all, adds nothing and takes nothing down', () => {
    const detail = 'ON MINI · ALPHA · BETA SIGNED IN';
    const notAWord = wearing(personal, { usedPercent: 42, word: 42 as unknown as string });
    expect(wordsFor(three, { kind: 'profile', item: notAWord }, 'hold').detail).toBe(detail);
    const nothing = wearing(personal, null as unknown as MonitorSpawnFuel);
    expect(wordsFor(three, { kind: 'profile', item: nothing }, 'hold').detail).toBe(detail);
  });

  it('a blank word adds nothing', () => {
    const words = wordsFor(
      three,
      { kind: 'profile', item: wearing(personal, { usedPercent: 42, word: '   ' }) },
      'hold',
    );
    expect(words.detail).toBe('ON MINI · ALPHA · BETA SIGNED IN');
    const peer = wearing(profileOn(mini.device, 'native'), { unread: true }, { signedIn: [] });
    expect(wordsFor(three, { kind: 'profile', item: peer }, 'hold').detail).toBe(
      'UNDER DEFAULT · THE AGENTS’ OWN SIGN-INS',
    );
  });
});
