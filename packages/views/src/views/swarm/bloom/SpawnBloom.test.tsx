import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  MonitorSpawnFuel,
  MonitorSpawnFuelArc,
  MonitorSpawnFuelDrawing,
  MonitorSpawnFuelNotch,
  MonitorSpawnMenu,
} from '@vibefield/puppeteer-view-sdk';
import { approximateBloomMeasure } from './canvas-measure.js';
import { FUEL_42, FUEL_48, FUEL_THREAD, fuelled } from './fuel-specimens.js';
import type { BloomPoint } from './geometry.js';
import { commitBloom, isInstant, keyBloom, openBloom, pointBloom, type BloomEnv, type BloomState } from './model.js';
import { BLOOM_SCENARIOS, type BloomScenarioId } from './scenarios.js';
import { SpawnBloom, bloomTargetWord } from './SpawnBloom.js';

// The overlay's MARKUP in posed states from the core: what a screen reader, a
// host's pointer tests (VibeField mounts the real AgentSwarm under happy-dom)
// and the catalog reach. The motion is CSS and needs a document; these pin the
// classes and hooks that motion keys off.

const env = (now = 1000): BloomEnv => ({ field: { w: 1000, h: 600 }, measure: approximateBloomMeasure, now });
const P: BloomPoint = { x: 500, y: 350 };

function open(id: BloomScenarioId, mode: 'hold' | 'sticky' | 'keys' = 'hold'): BloomState {
  const opened = openBloom(env(), P, mode, BLOOM_SCENARIOS[id]);
  if (isInstant(opened)) throw new Error('expected a bloom');
  return opened;
}

function budOf(s: BloomState, device: string, profile?: string) {
  const bud = [...s.l1, ...s.l2].find(
    (b) =>
      b.item.device.id === device &&
      (profile === undefined ? b.kind === 'device' : b.kind === 'profile' && b.item.profile?.id === profile),
  );
  if (!bud) throw new Error(`no bud ${device}/${profile ?? ''}`);
  return bud;
}

/** Point just past a bud from where its ring grows (reaching a desktop opens it). */
function toward(s: BloomState, device: string, profile?: string, now = 1000): BloomState {
  const bud = budOf(s, device, profile);
  return pointBloom(env(now), s, { x: bud.hx + (bud.x - bud.hx) * 1.02, y: bud.hy + (bud.y - bud.hy) * 1.02 });
}

const html = (state: BloomState | null) => renderToStaticMarkup(<SpawnBloom state={state} posed />);
const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

describe('the spawn bloom, posed', () => {
  it('keeps only its live region between blooms', () => {
    const idle = html(null);
    expect(idle).toContain('data-bloom-state="idle"');
    expect(idle).toContain('aria-live="polite"');
    expect(idle).not.toContain('role="menu"');
  });

  it('level one: one desktop blooms its profiles around the hub, the default filled and dotted', () => {
    const markup = html(open('one-three'));
    expect(markup).toContain('role="menu" aria-label="New terminal"');
    expect(markup).toContain('data-bloom-state="open"');
    expect(markup).toContain('data-bloom-level="1"');
    expect(markup).toContain('data-bloom-mode="hold"');
    expect(markup).toContain('data-bloom-target="hub"');
    expect(count(markup, /role="menuitem"/g)).toBe(3);
    expect(count(markup, /data-bloom-bud-kind="profile"/g)).toBe(3);
    expect(count(markup, /class="vf-bloom-bud is-out/g)).toBe(3);
    // This Mac is the laptop; Work (the default) is filled and waits on the person
    expect(markup).toContain('data-profile-glyph="laptop"');
    expect(markup).toMatch(
      /data-bloom-bud-id="work"[^>]*>.*?<svg[^>]*fill="currentColor"[^>]*data-profile-glyph="briefcase"/,
    );
    expect(count(markup, /class="vf-bloom-dot"/g)).toBe(1);
    // labels are seated, and hidden from the accessibility tree (the bud names itself)
    expect(count(markup, /class="vf-bloom-label is-out/g)).toBe(3);
    expect(markup).toContain('aria-label="Work, default"');
  });

  it('the words: a slate with the verb stepped back, the noun at full ink and the detail line', () => {
    const markup = html(open('one-three'));
    expect(markup).toContain('data-bloom-words="New terminal"');
    expect(markup).toContain('<span class="v">New </span><span class="n">terminal</span>');
    expect(markup).toContain('<div class="vf-bloom-say-detail">UNDER WORK · THE DEFAULT</div>');
    expect(markup).toMatch(/class="vf-bloom-say"[^>]*data-tone="go"/);
  });

  it('level two: reaching a desktop lifts it, dims its siblings and blooms its profiles from it', () => {
    const s = toward(open('two'), 'mini');
    expect(s.open?.item.device.id).toBe('mini');
    const markup = html(s);
    expect(markup).toContain('data-bloom-level="2"');
    expect(markup).toContain('data-bloom-target="device:mini"');
    expect(markup).toMatch(/class="vf-bloom-bud is-out is-hot is-path"[^>]*data-bloom-bud-id="mini"/);
    expect(markup).toMatch(/class="vf-bloom-bud is-out is-dim"[^>]*data-bloom-bud-id="studio"/);
    expect(count(markup, /data-bloom-ring="2"/g)).toBe(2);
    // a peer's native set reads DEFAULT (SB-D10)
    expect(markup).toContain('aria-label="DEFAULT, default, on mini"');
    expect(markup).toContain('data-bloom-words="Open on mini"');
    expect(markup).toContain('>UNDER DEFAULT</div>');
    // the tether runs from the hub's rim through the open desktop to the pointer
    expect(markup).toMatch(/<path class="vf-bloom-tether" d="M[\d.]+ [\d.]+ L[\d.]+ [\d.]+ L[\d.]+ [\d.]+"/);
  });

  it('a profile on the second ring, once the ring has settled', () => {
    const s = toward(toward(open('two'), 'mini'), 'mini', 'personal', 2000);
    const markup = html(s);
    expect(markup).toContain('data-bloom-target="profile:personal"');
    expect(markup).toMatch(/class="vf-bloom-bud is-out is-hot"[^>]*data-bloom-bud-id="personal"/);
    expect(markup).toContain('data-bloom-words="Open as Personal"');
    expect(bloomTargetWord(s.target)).toBe('profile:personal');
  });

  it('a faint desktop is disabled, dashed, and the words say why nothing opens', () => {
    const s = toward(open('three'), 'air');
    const markup = html(s);
    expect(markup).toContain('data-bloom-target="device:air"');
    expect(markup).toMatch(
      /class="vf-bloom-bud is-out is-hot is-off"[^>]*aria-disabled="true"[^>]*data-bloom-bud-id="air"/,
    );
    expect(markup).toContain('<small>ASLEEP · 2 H</small>');
    expect(markup).toMatch(/data-tone="off"[^>]*data-bloom-words="Air is asleep"/);
    expect(markup).toContain('NOTHING OPENS · ASLEEP · 2 H');
  });

  it('keys: the first bud is focused and named as the active descendant, the menu holds the keys', () => {
    const s = open('three', 'keys');
    const markup = html(s);
    expect(markup).toContain('data-bloom-mode="keys"');
    expect(markup).toContain('data-bloom-holds-keys="true"');
    const active = /aria-activedescendant="([^"]+)"/.exec(markup)?.[1];
    expect(active).toBeTruthy();
    expect(markup).toMatch(new RegExp(`id="${active}" class="vf-bloom-bud is-out is-hot is-focus"`));
    expect(markup).toContain('data-bloom-words="Open on studio"');
    // no tether from the keyboard
    expect(markup).not.toContain('vf-bloom-tether');
    // ↵ on a desktop that blooms opens it, focusing its default
    const opened = keyBloom(env(1100), s, 'Enter').state;
    const next = html(opened);
    expect(next).toContain('data-bloom-level="2"');
    expect(next).toContain('data-bloom-target="profile:work"');
  });

  it('a hold never holds the keys (the pointer does); a secondary click does', () => {
    expect(html(open('two'))).not.toContain('data-bloom-holds-keys');
    expect(html(open('two', 'sticky'))).toContain('data-bloom-holds-keys="true"');
  });

  it('after letting go: the chosen bud grows into the body, the rest go home, the words say Opening', () => {
    const s = toward(open('one-three'), 'studio', 'demo');
    const done = commitBloom({ ...env(1200), idleRadius: 50 }, s);
    expect(done.choice?.profileSet).toBe('demo');
    const markup = html(done.state);
    expect(markup).toContain('data-bloom-state="committed"');
    expect(markup).toMatch(
      /class="vf-bloom-bud is-out is-chosen is-hot"[^>]*data-bloom-bud-id="demo"[^>]*--mv-swarm-bloom-grow:2\.08/,
    );
    expect(count(markup, /class="vf-bloom-bud is-back/g)).toBe(2);
    // every label leaves at once, the chosen one's too
    expect(markup).not.toContain('vf-bloom-label is-out');
    expect(markup).toContain('data-bloom-words="Opening as Demo"');
    expect(markup).not.toContain('aria-activedescendant');
  });

  it('a cancel closes without a chosen bud', () => {
    const s = pointBloom(env(), open('two'), { x: P.x, y: P.y + 200 });
    const done = commitBloom(env(1200), s);
    expect(done.choice).toBeNull();
    const markup = html(done.state);
    expect(markup).toContain('data-bloom-state="cancelled"');
    expect(markup).not.toContain('is-chosen');
  });
});

const bloomOf = (menu: MonitorSpawnMenu): BloomState => {
  const opened = openBloom(env(), P, 'hold', menu);
  if (isInstant(opened)) throw new Error('expected a bloom');
  return opened;
};

/** One Mac's three profiles, Work (the default, blocked) wearing `fuel`. */
const work = (fuel: MonitorSpawnFuel): BloomState => bloomOf(fuelled('one-three', { work: fuel }));

describe("the spawn bloom's fuel", () => {
  it('a profile with a reading wears a ring: the track, the fill to its share, a tick at the time gone', () => {
    const markup = html(work({ usedPercent: 42, elapsedPercent: 25 }));
    expect(count(markup, /class="vf-bloom-fuel"/g)).toBe(1);
    // whole elements: a dash means its share only on `pathLength` 100, and only a circle centred on the bud is the rim
    expect(markup).toContain(
      '<svg class="vf-bloom-fuel" width="48" height="48" viewBox="0 0 48 48" aria-hidden="true" style="position:absolute;inset:0;overflow:visible">',
    );
    expect(markup).toContain('<circle class="vf-bloom-fuel-track" cx="24" cy="24" r="21.62" stroke-width="3.17"');
    expect(markup).toContain(
      '<circle class="vf-bloom-fuel-fill" cx="24" cy="24" r="21.62" stroke-width="3.17" pathLength="100" transform="rotate(-85.8 24 24)" style="stroke-dasharray:41.02 200"',
    );
    expect(markup).toMatch(/class="vf-bloom-fuel-tick" x1="42.42" y1="26.03" x2="48.55" y2="26.71"/);
    // the ring sits under the blocked dot: the dot comes later in the face
    expect(markup.indexOf('class="vf-bloom-fuel"')).toBeLessThan(markup.indexOf('class="vf-bloom-dot"'));
  });

  it('a bud on the second ring sizes its ring to itself', () => {
    const markup = html(toward(bloomOf(fuelled('two', { personal: { usedPercent: 42 } })), 'mini'));
    expect(markup).toContain(
      '<svg class="vf-bloom-fuel" width="42" height="42" viewBox="0 0 42 42" aria-hidden="true" style="position:absolute;inset:0;overflow:visible">',
    );
    expect(markup).toContain('<circle class="vf-bloom-fuel-track" cx="21" cy="21" r="18.81" stroke-width="2.77"');
    expect(markup).toContain(
      '<circle class="vf-bloom-fuel-fill" cx="21" cy="21" r="18.81" stroke-width="2.77" pathLength="100" transform="rotate(-85.78 21 21)" style="stroke-dasharray:41.02 200"',
    );
  });

  // The orange and the half are the sheet's; test/spawn-bloom-fuel-sheet.test.ts reads them. This pins the classes.
  it('a window running hot and an old reading mark the fill, and a targeted bud keeps its own is-hot', () => {
    const s = toward(work({ usedPercent: 92, hot: true, stale: true }), 'studio', 'work');
    const markup = html(s);
    expect(markup).toContain('class="vf-bloom-fuel-fill is-fuel-hot is-fuel-stale"');
    // a bud's `is-hot` still means targeted, and only that
    expect(markup).toMatch(/class="vf-bloom-bud is-out is-hot"[^>]*data-bloom-bud-id="work"/);
    expect(count(markup, /class="vf-bloom-bud[^"]* is-hot/g)).toBe(1);
  });

  it('a fill is marked hot or old only by its own flag, and only when the flag is exactly true', () => {
    const fill = (fuel: MonitorSpawnFuel) => /class="(vf-bloom-fuel-fill[^"]*)"/.exec(html(work(fuel)))?.[1];
    expect(fill({ usedPercent: 42 })).toBe('vf-bloom-fuel-fill');
    expect(fill({ usedPercent: 42, hot: false, stale: false })).toBe('vf-bloom-fuel-fill');
    expect(fill({ usedPercent: 42, hot: true })).toBe('vf-bloom-fuel-fill is-fuel-hot');
    expect(fill({ usedPercent: 42, stale: true })).toBe('vf-bloom-fuel-fill is-fuel-stale');
    const loose = { usedPercent: 42, hot: 'false', stale: 1 } as unknown as MonitorSpawnFuel;
    expect(fill(loose)).toBe('vf-bloom-fuel-fill');
  });

  it('a share past 100 fills the ring, never more', () => {
    expect(html(work({ usedPercent: 130 }))).toContain('stroke-dasharray:97.67 200');
  });

  it("the bud's accessible name says its fuel", () => {
    const markup = html(work({ usedPercent: 42, word: 'Plan: 42% of 5 hours' }));
    expect(markup).toContain('aria-label="Work, default, plan: 42% of 5 hours"');
    // a word with no reading to draw still speaks
    expect(html(work({ word: 'Plan: 42% of 5 hours' }))).toContain('aria-label="Work, default, plan: 42% of 5 hours"');
  });

  it('a second-ring bud says its fuel before its desktop', () => {
    const fuel = { usedPercent: 42, word: 'Plan: 42% of 5 hours' };
    const markup = html(toward(bloomOf(fuelled('two', { personal: fuel })), 'mini'));
    expect(markup).toContain('aria-label="PERSONAL, plan: 42% of 5 hours, on mini"');
  });

  it("a tick outside its window stands at the window's end", () => {
    const at = (elapsedPercent: number) => html(work({ usedPercent: 42, elapsedPercent }));
    expect(at(130)).toContain('vf-bloom-fuel-tick');
    expect(at(130)).toBe(at(100));
    expect(at(-5)).toBe(at(0));
  });

  it('a reading with no time to mark draws no tick', () => {
    const elapsed = (elapsedPercent: unknown) =>
      html(work({ usedPercent: 42, elapsedPercent: elapsedPercent as number }));
    const none = html(work({ usedPercent: 42 }));
    expect(none).toContain('vf-bloom-fuel-fill');
    expect(none).not.toContain('vf-bloom-fuel-tick');
    for (const malformed of [Number.NaN, Number.POSITIVE_INFINITY, '25', null]) {
      expect(elapsed(malformed)).toBe(none);
    }
  });

  it('a reading at nothing keeps its ring and has nothing to fill', () => {
    const at = (usedPercent: number) => html(work({ usedPercent, elapsedPercent: 25 }));
    const fresh = at(0);
    expect(fresh).toContain('vf-bloom-fuel-track');
    expect(fresh).toContain('vf-bloom-fuel-tick');
    expect(fresh).not.toContain('vf-bloom-fuel-fill');
    expect(at(0.4)).toBe(fresh);
    expect(at(-5)).toBe(fresh);
    // the first share the eye can see fills
    expect(at(0.5)).toContain('stroke-dasharray:0.49 200');
  });

  it('a profile the host cannot read draws a thread, and a number wins over it', () => {
    const unread = html(work({ unread: true }));
    expect(unread).toContain(
      '<circle class="vf-bloom-fuel-thread" cx="24" cy="24" r="21.62" stroke-width="1.15" style="stroke-dasharray:0.01 2.99"',
    );
    expect(unread).not.toContain('vf-bloom-fuel-fill');
    const reading = html(work({ unread: true, usedPercent: 42 }));
    expect(reading).toContain('vf-bloom-fuel-fill');
    expect(reading).not.toContain('vf-bloom-fuel-thread');
  });

  it('a host that gives no fuel draws a face of its glyph and its dot, and nothing else', () => {
    const today = html(open('one-three'));
    expect(today).not.toContain('vf-bloom-fuel');
    const faces = [...today.matchAll(/<span class="vf-bloom-face">(.*?)<\/span>/g)].map((face) =>
      (face[1] as string).replace(/<svg[^>]*data-profile-glyph="[^"]*".*?<\/svg>/, 'GLYPH'),
    );
    expect(faces).toEqual(['GLYPH', 'GLYPH<i class="vf-bloom-dot"></i>', 'GLYPH']);
  });

  it('a fuel key holding nothing draws what no key draws', () => {
    expect(html(bloomOf(fuelled('one-three', { work: undefined })))).toBe(html(open('one-three')));
  });

  it('a malformed reading draws no ring', () => {
    expect(html(work({ usedPercent: Number.NaN }))).not.toContain('vf-bloom-fuel');
    expect(html(work({ usedPercent: '42' as unknown as number }))).not.toContain('vf-bloom-fuel');
    expect(html(bloomOf(fuelled('one-three', { work: 'full' as unknown as MonitorSpawnFuel })))).not.toContain(
      'vf-bloom-fuel',
    );
    expect(html(work({ word: 'Plan: 42% of 5 hours' }))).not.toContain('vf-bloom-fuel');
  });

  it('nothing a host sends takes the bloom down or draws a ring it did not read', () => {
    const today = html(open('one-three'));
    for (const fuel of [null, 42, true]) {
      expect(html(bloomOf(fuelled('one-three', { work: fuel as unknown as MonitorSpawnFuel })))).toBe(today);
    }
    for (const usedPercent of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(html(work({ usedPercent }))).toBe(today);
    }
    for (const unread of [1, 'true']) {
      expect(html(work({ unread: unread as unknown as boolean }))).toBe(today);
    }
    expect(html(work({ word: 42 as unknown as string }))).toBe(today);
  });

  it("a desktop's bud never wears one", () => {
    // mini's default profile is fuelled, and level one draws mini itself
    const markup = html(bloomOf(fuelled('two', { native: { usedPercent: 42 }, work: { usedPercent: 42 } })));
    expect(count(markup, /data-bloom-bud-kind="device"/g)).toBe(2);
    expect(markup).not.toContain('vf-bloom-fuel');
  });
});

// The host draws the picture (`MonitorSpawnFuel.drawn`) and the bud draws it as handed: arcs as paths, a whole ring as
// a circle, each stroke's tone and share for the sheet. Paths here are worked by hand from the specimens.
describe("the spawn bloom's drawn fuel", () => {
  /** A one-arc drawing for a disc `size` across, to tell which size a bud picked. */
  const ring = (size: number): MonitorSpawnFuelDrawing => ({
    size,
    arcs: [{ r: size / 2 - 2, width: 2, from: -90, to: 0, tone: 'ink', percent: 64 }],
  });
  const arcs = (markup: string) => count(markup, /class="vf-bloom-fuel-arc"/g);
  const notches = (markup: string) => count(markup, /class="vf-bloom-fuel-notch"/g);
  /** The box of the drawing Work's 48 bud picked from `drawn` (a glyph's own svg has a box too). */
  const box = (drawn: readonly MonitorSpawnFuelDrawing[]): string | undefined =>
    /class="vf-bloom-fuel is-drawn" width="48" height="48" viewBox="(0 0 \d+ \d+)"/.exec(html(work({ drawn })))?.[1];

  it('a 48 bud draws its drawing: arcs as paths, a whole ring as a circle, each with its tone and share', () => {
    const markup = html(work({ drawn: [FUEL_48] }));
    expect(markup).toContain(
      '<svg class="vf-bloom-fuel is-drawn" width="48" height="48" viewBox="0 0 48 48" aria-hidden="true" style="position:absolute;inset:0;overflow:visible">',
    );
    const strokes = [
      '<circle class="vf-bloom-fuel-arc" data-tone="ink" cx="24" cy="24" r="21.6" stroke-width="3.2" stroke-linecap="round" transform="rotate(-90 24 24)" style="--mv-swarm-bloom-fuel-share:12%"',
      '<path class="vf-bloom-fuel-arc" data-tone="ink" d="M24 2.4A21.6 21.6 0 0 1 45.6 24" stroke-width="3.2" stroke-linecap="round" style="--mv-swarm-bloom-fuel-share:64%"',
      '<circle class="vf-bloom-fuel-arc" data-tone="ink" cx="24" cy="24" r="17.6" stroke-width="3.2" stroke-linecap="butt" transform="rotate(-90 24 24)" style="--mv-swarm-bloom-fuel-share:12%"',
      // past a half turn, two halves
      '<path class="vf-bloom-fuel-arc" data-tone="hot" d="M24 6.4A17.6 17.6 0 0 1 24 41.6A17.6 17.6 0 0 1 6.4 24" stroke-width="3.2" stroke-linecap="round" opacity="0.5" style="--mv-swarm-bloom-fuel-share:88%"',
      '<line class="vf-bloom-fuel-notch" data-tone="ink" x1="42" y1="24" x2="49" y2="24" stroke-width="1.25" style="--mv-swarm-bloom-fuel-share:84%"',
    ];
    for (const stroke of strokes) expect(markup).toContain(stroke);
    // in the order handed, the arcs then the notches
    const at = strokes.map((stroke) => markup.indexOf(stroke));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect([arcs(markup), notches(markup)]).toEqual([4, 1]);
    // the one-arc ring's own parts are not drawn
    expect(markup).not.toMatch(/vf-bloom-fuel-(?:track|fill|tick|thread)/);
  });

  it('a 42 bud picks the drawing made for it', () => {
    const markup = html(toward(bloomOf(fuelled('two', { personal: { drawn: [FUEL_48, FUEL_42] } })), 'mini'));
    expect(markup).toContain('<svg class="vf-bloom-fuel is-drawn" width="42" height="42" viewBox="0 0 42 42"');
    expect(markup).toContain('d="M21 2.1A18.9 18.9 0 0 1 39.9 21"');
    expect(markup).toContain('cx="21" cy="21" r="18.9"');
    expect([arcs(markup), notches(markup)]).toEqual([4, 1]);
  });

  it('a bud with no drawing at its size scales the nearest, the larger on a tie', () => {
    // a 42 bud scales the 48 drawing: its own width, the drawing's box and numbers
    const scaled = html(toward(bloomOf(fuelled('two', { personal: { drawn: [FUEL_48] } })), 'mini'));
    expect(scaled).toContain('<svg class="vf-bloom-fuel is-drawn" width="42" height="42" viewBox="0 0 48 48"');
    expect(scaled).toContain('d="M24 2.4A21.6 21.6 0 0 1 45.6 24"');
    expect(box([ring(40), ring(60)])).toBe('0 0 40 40');
    expect(box([ring(60), ring(40)])).toBe('0 0 40 40');
    expect(box([ring(44), ring(52)])).toBe('0 0 52 52');
    expect(box([ring(52), ring(44)])).toBe('0 0 52 52');
  });

  it('a valid drawing wins over the one-arc fields, and hot and stale do not touch it', () => {
    const fuel = { drawn: [FUEL_48], usedPercent: 42, elapsedPercent: 25, unread: true, hot: true, stale: true };
    const markup = html(work(fuel));
    expect(count(markup, /<svg class="vf-bloom-fuel/g)).toBe(1);
    expect(markup).toContain('class="vf-bloom-fuel is-drawn"');
    expect(markup).not.toMatch(/vf-bloom-fuel-(?:track|fill|tick|thread)/);
    expect(markup).not.toContain('is-fuel-');
  });

  it('a thread is a dashed stroke with round caps', () => {
    expect(html(work({ drawn: [FUEL_THREAD] }))).toContain(
      '<circle class="vf-bloom-fuel-arc" data-tone="ink" cx="24" cy="24" r="19.5" stroke-width="1.8" stroke-linecap="round" transform="rotate(-90 24 24)" style="--mv-swarm-bloom-fuel-share:46%;stroke-dasharray:0.01 4.8"',
    );
  });

  it('a targeted bud keeps its strokes and its own is-hot, and the drawing sits under the blocked dot', () => {
    const markup = html(toward(work({ drawn: [FUEL_48] }), 'studio', 'work'));
    expect(markup).toMatch(/class="vf-bloom-bud is-out is-hot"[^>]*data-bloom-bud-id="work"/);
    expect(count(markup, /class="vf-bloom-bud[^"]* is-hot/g)).toBe(1);
    expect([arcs(markup), notches(markup)]).toEqual([4, 1]);
    const drawing = markup.indexOf('class="vf-bloom-fuel is-drawn"');
    expect(drawing).toBeGreaterThan(-1);
    expect(drawing).toBeLessThan(markup.indexOf('class="vf-bloom-dot"'));
  });

  it('a stroke past the rim, the 49th arc, the 17th notch and a fifth drawing are not drawn', () => {
    const arc = (r: number, width: number): MonitorSpawnFuelArc => ({
      r,
      width,
      from: -90,
      to: 0,
      tone: 'ink',
      percent: 64,
    });
    const notch = (x2: number): MonitorSpawnFuelNotch => ({
      x1: 24,
      y1: 24,
      x2,
      y2: 24,
      width: 1,
      tone: 'ink',
      percent: 84,
    });
    // a stroke may reach 2 past the rim of a 48 disc (26 from its middle), and no further
    const reach: MonitorSpawnFuelDrawing = {
      size: 48,
      arcs: [arc(24, 4), arc(24, 4.2)],
      notches: [notch(50), notch(50.1)],
    };
    const edge = html(work({ drawn: [reach] }));
    expect([arcs(edge), notches(edge)]).toEqual([1, 1]);
    expect(edge).toContain('stroke-width="4"');
    expect(edge).not.toContain('stroke-width="4.2"');
    expect(edge).toContain('x2="50"');
    expect(edge).not.toContain('x2="50.1"');
    // 48 arcs and 16 notches a drawing
    const many: MonitorSpawnFuelDrawing = {
      size: 48,
      arcs: Array.from({ length: 49 }, (_, i) => ({ ...arc(20, 1), from: i * 7, to: i * 7 + 5 })),
      notches: Array.from({ length: 17 }, (_, i) => notch(30 + i * 0.25)),
    };
    const full = html(work({ drawn: [many] }));
    expect([arcs(full), notches(full)]).toEqual([48, 16]);
    // the first 4 valid drawings count: a fifth is not read, and an invalid one takes no place
    expect(box([ring(10), ring(20), ring(30), ring(40), FUEL_48])).toBe('0 0 40 40');
    const first = [{ size: 0, arcs: FUEL_48.arcs }, { size: 48, arcs: [] }, ring(10), ring(20), ring(30), FUEL_48];
    expect(box(first)).toBe('0 0 48 48');
  });

  it('a drawing with no stroke the bud can draw leaves the one-arc fields as they were', () => {
    const bad: MonitorSpawnFuelDrawing = {
      size: 48,
      arcs: [
        { r: 21.6, width: 3.2, from: -90, to: 0, tone: 'attention' as unknown as 'ink', percent: 64 },
        { r: -1, width: 3.2, from: -90, to: 0, tone: 'ink', percent: 64 },
        { r: 21.6, width: 3.2, from: 0, to: 0, tone: 'ink', percent: 64 },
        { r: 21.6, width: Number.NaN, from: -90, to: 0, tone: 'ink', percent: 64 },
      ],
      notches: [{ x1: 42, y1: 24, x2: 49, y2: 24, width: 0, tone: 'ink', percent: 84 }],
    };
    expect(html(work({ drawn: [bad], usedPercent: 42 }))).toBe(html(work({ usedPercent: 42 })));
    const unsized = { size: Number.NaN, arcs: FUEL_48.arcs };
    expect(html(work({ drawn: [bad, unsized], unread: true }))).toBe(html(work({ unread: true })));
    expect(html(work({ drawn: [bad] }))).toBe(html(open('one-three')));
  });

  it('a `drawn` that is empty, not a list, or holds no drawing changes nothing', () => {
    const fuels: MonitorSpawnFuel[] = [{ usedPercent: 42 }, { unread: true }, { word: 'Plan: 42% of 5 hours' }];
    const malformed: unknown[] = [[], 'x', [null], [42], { size: 48, arcs: FUEL_48.arcs }];
    for (const fuel of fuels) {
      const plain = html(work(fuel));
      for (const drawn of malformed) {
        expect([drawn, html(work({ ...fuel, drawn } as unknown as MonitorSpawnFuel))]).toEqual([drawn, plain]);
      }
    }
  });

  it("a drawn bud's accessible name is its word's clause alone", () => {
    const word = 'Plan: 42% of 5 hours';
    expect(html(work({ drawn: [FUEL_48], word }))).toContain('aria-label="Work, default, plan: 42% of 5 hours"');
    expect(html(work({ drawn: [FUEL_48] }))).toContain('aria-label="Work, default"');
  });

  it("a desktop's bud never draws one", () => {
    // mini's default profile is fuelled, and level one draws mini itself
    const fuel = { drawn: [FUEL_48], usedPercent: 42 };
    const markup = html(bloomOf(fuelled('two', { native: fuel, work: fuel })));
    expect(count(markup, /data-bloom-bud-kind="device"/g)).toBe(2);
    expect(markup).not.toContain('vf-bloom-fuel');
  });
});
